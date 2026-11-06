# Alibaba Cloud RAM OIDC

Use Bash, `jq`, OpenSSL, and a current Alibaba Cloud CLI with OIDC mode support.
Administrator credentials remain on the local machine. Confirm the account and permissions before writes.
Every `aliyun` command in OIDC mode requires `--region` (even for global services such as `ram` and `ims`) and `--role-session-name` (2–64 characters).
Examples use approved values in shell variables; substitute all `<...>` fields before execution.

## Provider inspection and creation

Alibaba Cloud CLI places OIDC IdP operations under the `ims` product (`aliyun ims ...`), while the underlying RAM authorization actions remain `ram:*OIDCProvider`.

```bash
aliyun ims ListOIDCProviders --region cn-hangzhou
aliyun ims GetOIDCProvider --OIDCProviderName NiaTeamsWorkload --region cn-hangzhou
FINGERPRINTS=$(set -o pipefail; openssl s_client -verify_return_error -servername nia-teams.com -showcerts -connect nia-teams.com:443 </dev/null 2>/dev/null \
  | awk '/-----BEGIN CERTIFICATE-----/{c=""} {c=c $0 "\n"} /-----END CERTIFICATE-----/{print c | "openssl x509 -noout -fingerprint -sha1"; close("openssl x509 -noout -fingerprint -sha1")}' \
  | cut -d= -f2 | tr -d ':' | paste -sd, -)
```

Include all certificates in the verified TLS chain (leaf, intermediate CA, and root CA) as comma-separated hex SHA-1 fingerprints without colons so intermediate CA fingerprints continue to match across leaf certificate renewals.
`--ClientIds` and `--Fingerprints` take comma-separated strings (not JSON arrays). Compare issuer, client IDs and fingerprints before reusing a shared provider.

```bash
aliyun ims CreateOIDCProvider --OIDCProviderName NiaTeamsWorkload \
  --IssuerUrl https://nia-teams.com --ClientIds nia-teams-workload \
  --Fingerprints "${FINGERPRINTS}" --region cn-hangzhou
aliyun ims GetOIDCProvider --OIDCProviderName NiaTeamsWorkload --region cn-hangzhou
```

Record the returned OIDC provider ARN; expected shape is
`acs:ram::<accountId>:oidc-provider/NiaTeamsWorkload`.

## Exact trust documents

Choose cloud role names separately from the Nia Teams role key. Role trust policies use `"Action": "sts:AssumeRole"` with the OIDC provider ARN as the `Federated` principal.

```bash
ACCOUNT_ID='<accountId>'
ROLE_KEY='agent.<agentSlug>.<name>'
PROVIDER_ARN="acs:ram::${ACCOUNT_ID}:oidc-provider/NiaTeamsWorkload"
RESIDENT_ROLE='<approved resident cloud role name>'
ELEVATED_ROLE='<approved elevated cloud role name>'
jq -n --arg provider "$PROVIDER_ARN" --arg sub "role:${ROLE_KEY}" \
  '{Version:"1",Statement:[{Effect:"Allow",Action:"sts:AssumeRole",
    Principal:{Federated:[$provider]},Condition:{StringEquals:{
      "oidc:iss":"https://nia-teams.com","oidc:aud":"nia-teams-workload",
      "oidc:sub":[$sub,($sub+":elevated")]}}}]}' > resident-trust.json
jq --arg sub "role:${ROLE_KEY}:elevated" \
  '.Statement[0].Condition.StringEquals["oidc:sub"]=$sub' \
  resident-trust.json > elevated-trust.json
```

Ordinary-tier `oidc:sub` is an array of the two exact subjects (so elevated sessions retain ordinary access). Elevated-tier `oidc:sub` is only the elevated string.
Provision the ordinary role, the elevated role, or both according to the enabled permission tiers:

```bash
aliyun ram CreateRole --RoleName "$RESIDENT_ROLE" \
  --AssumeRolePolicyDocument "$(cat resident-trust.json)" --region cn-hangzhou
aliyun ram AttachPolicyToRole --RoleName "$RESIDENT_ROLE" \
  --PolicyType Custom --PolicyName '<approved least-privilege read policy>' --region cn-hangzhou
aliyun ram CreateRole --RoleName "$ELEVATED_ROLE" \
  --AssumeRolePolicyDocument "$(cat elevated-trust.json)" --region cn-hangzhou
# Root/admin-equivalent example: execute only after explicit approval.
aliyun ram AttachPolicyToRole --RoleName "$ELEVATED_ROLE" \
  --PolicyType System --PolicyName AdministratorAccess --region cn-hangzhou
```

Prefer service-scoped custom policies (`--PolicyType Custom`) over the system `ReadOnlyAccess` policy for resident roles: `ReadOnlyAccess` grants `*:*Get*` and `*:*Describe*` across the account, which exposes KMS secret values, ACK kubeconfigs, SAE secrets, SSL certificate private keys, and OSS object contents. When authoring custom `Allow` or `Deny` policies, verify the exact RAM permission prefix for each product rather than assuming it matches the CLI/API product name (for example, SSL certificates use `yundun-cert:*` and domain contact queries use `domain:QueryCommonInfo`).
For existing roles inspect first; changing trust uses `aliyun ram UpdateRole --RoleName ... --NewAssumeRolePolicyDocument ...` after approval, preserving unrelated authorized trust.
Read back each provisioned role and policy attachment:

```bash
aliyun ram GetRole --RoleName "$RESIDENT_ROLE" --region cn-hangzhou
aliyun ram ListPoliciesForRole --RoleName "$RESIDENT_ROLE" --region cn-hangzhou
aliyun ram GetRole --RoleName "$ELEVATED_ROLE" --region cn-hangzhou
aliyun ram ListPoliciesForRole --RoleName "$ELEVATED_ROLE" --region cn-hangzhou
```

## Sandbox commands

Pass the OIDC flags inline on each `aliyun` invocation, using a private token file.
Always include `--role-session-name` (2–64 characters) and `--region` on every `aliyun` command; omitting either in OIDC mode fails with `profile configuration failed`.

## Local live verification

Use a private `0600` `role-response.json` containing the role PUT response.
Set `PROVIDER_ARN`, `RESIDENT_ARN`, `ELEVATED_ARN`, and `REGION` to the approved actual values.
This function exercises the approved workload's OIDC identity:

```bash
verify_ram() (
  set -eu; set +x; umask 077
  token_file="$(mktemp)"; trap 'rm -f "$token_file"' EXIT
  jq -er --arg field "$1" '.tokens[$field]' role-response.json > "$token_file"
  aliyun sts GetCallerIdentity --mode OIDC --oidc-provider-arn "$PROVIDER_ARN" \
    --ram-role-arn "$2" --oidc-token-file "$token_file" \
    --role-session-name nia-verification --region "$REGION"
)
  # Ordinary tier enabled: expect success.
verify_ram roleToken "$RESIDENT_ARN"
# Elevated tier enabled: ordinary token must be denied by elevated role trust.
verify_ram roleToken "$ELEVATED_ARN"
# Elevated tier enabled: expect success (and test ordinary role if both tiers are enabled).
verify_ram elevatedRoleToken "$ELEVATED_ARN"
verify_ram elevatedRoleToken "$RESIDENT_ARN"
```

Run the calls applicable to the enabled tier(s). Inspect returned account and assumed role identity.
Review effective resource permissions separately; GetCallerIdentity only demonstrates token exchange.
Clean up the private response after verification. Removing RAM policies/trust blocks future assumptions;
review already-issued STS sessions separately.

Sources: [RAM OIDC](https://www.alibabacloud.com/help/en/ram/user-guide/role-based-sso-overview/),
[Alibaba Cloud CLI OIDC mode](https://www.alibabacloud.com/help/en/cli/configure-credentials).

## Role prompt templates

以下为虚构部署；保存前替换为已批准的账号、角色、地域、资源与 endpoint/CA。
仅启用普通权限时 `sessionElevationEnabled: false` 且 `elevationPrompt` 为空；启用提权权限时设 `sessionElevationEnabled: true` 并配置下方 `elevationPrompt`（若未启用普通权限，`systemPrompt` 只写受控范围与提权要求，不含常驻读取命令）。

### Ordinary tier — systemPrompt

`agent.ops-agent.aliyun` 是阿里云账号 `1000000000000001` 的日常巡检身份，普通权限为只读 `cn-hangzhou` SLS project `production` 下 `payments-api` 的日志：

```bash
nia role-token agent.ops-agent.aliyun > /tmp/nia-aliyun.jwt
aliyun sls GetLogs --project production --logstore payments-api \
  --from "$(($(date +%s)-900))" --to "$(date +%s)" --query "level:ERROR" \
  --mode OIDC \
  --oidc-provider-arn acs:ram::1000000000000001:oidc-provider/NiaTeamsWorkload \
  --ram-role-arn acs:ram::1000000000000001:role/acme-observer \
  --oidc-token-file /tmp/nia-aliyun.jwt \
  --role-session-name ops-agent-sls --region cn-hangzhou
```

（若同时启用提权权限，追加一句：）重启 SAE 应用 `payments-api` 前，先说明目标对象、动作和副作用，再调用 `request_session_elevation`。

### Elevated tier only — systemPrompt

`agent.ops-agent.aliyun` 是阿里云账号 `1000000000000001` 的受控运维身份，提权后允许重启 `cn-hangzhou` 的 SAE 应用 `payments-api`（AppId `f773076b-588f-479a-8888-000000000001`）。日常无常驻权限。执行上述操作前先说明目标对象、动作和副作用，调用 `request_session_elevation`。

### Elevated tier — elevationPrompt

已批准重启 `cn-hangzhou` 的 SAE 应用 `payments-api`（AppId `f773076b-588f-479a-8888-000000000001`）。将 `--ram-role-arn` 设为 `acs:ram::1000000000000001:role/acme-operator`：

```bash
nia role-token agent.ops-agent.aliyun > /tmp/nia-aliyun.jwt
aliyun sae RestartApplication --AppId f773076b-588f-479a-8888-000000000001 \
  --mode OIDC \
  --oidc-provider-arn acs:ram::1000000000000001:oidc-provider/NiaTeamsWorkload \
  --ram-role-arn acs:ram::1000000000000001:role/acme-operator \
  --oidc-token-file /tmp/nia-aliyun.jwt \
  --role-session-name ops-agent-sae --region cn-hangzhou
```
