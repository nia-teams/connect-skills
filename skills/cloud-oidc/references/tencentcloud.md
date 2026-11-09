# Tencent Cloud CAM OIDC

Use Bash, `jq`, `curl`, OpenSSL, and a current `tccli` (`>= 3.1.197`) in the administrator environment.
Administrator credentials remain on the local machine. Confirm the active CLI profile and root account UIN via `tccli sts GetCallerIdentity` before writes; UIN is not APPID.
Nia Teams sandboxes preinstall `tccli`, `aliyun`, and `kubectl`; target Agent commands use `nia` and the `tccli` OIDC credential provider, not administrator CLI credentials.
Examples use approved values in variables; substitute all `<...>` fields before execution.

## Provider inspection and creation

Inspect existing CAM OIDC configuration first and reuse `NiaTeamsWorkload` when `IdentityUrl` and `ClientId` already match:

```bash
tccli sts GetCallerIdentity --region ap-beijing
tccli cam DescribeOIDCConfig --Name NiaTeamsWorkload --region ap-beijing
curl -fsS https://nia-teams.com/.well-known/openid-configuration | jq '{issuer,jwks_uri}'
curl -fsS https://nia-teams.com/oauth2/jwks -o nia-jwks.json
jq -e '.keys | length > 0' nia-jwks.json >/dev/null
IDENTITY_KEY="$(openssl base64 -A -in nia-jwks.json)"
```

`IdentityKey` is the single-line Base64 of the complete JWKS JSON document (not a PEM certificate or the JWKS URL).
If `NiaTeamsWorkload` does not yet exist, create it with `--AutoRotateKey 1` (verify against current Tencent Cloud CAM API docs before running on a new account, and never overwrite a shared provider without reviewing existing roles):

```bash
tccli cam CreateOIDCConfig --Name NiaTeamsWorkload \
  --IdentityUrl https://nia-teams.com \
  --ClientId '["nia-teams-workload"]' \
  --IdentityKey "$IDENTITY_KEY" \
  --AutoRotateKey 1 \
  --Description 'Nia Teams Workload OIDC' \
  --region ap-beijing
tccli cam DescribeOIDCConfig --Name NiaTeamsWorkload --region ap-beijing
```

## Exact trust documents and CAM resource QCS pitfalls

Choose cloud role names separately from the Nia Teams role key. Tencent Cloud CAM OIDC trust policies use `"version": "2.0"`, `"action": "name/sts:AssumeRoleWithWebIdentity"`, and Federated principal `qcs::cam::uin/<UIN>:oidc-provider/NiaTeamsWorkload`:

```bash
UIN='<uin>'
ROLE_KEY='agent.<agentSlug>.<name>'
PROVIDER_QCS="qcs::cam::uin/${UIN}:oidc-provider/NiaTeamsWorkload"
RESIDENT_ROLE='<approved resident cloud role name>'
ELEVATED_ROLE='<approved elevated cloud role name>'
jq -n --arg provider "$PROVIDER_QCS" --arg sub "role:${ROLE_KEY}" \
  '{version:"2.0",statement:[{effect:"allow",action:"name/sts:AssumeRoleWithWebIdentity",
    principal:{federated:[$provider]},condition:{string_equal:{
      "oidc:iss":"https://nia-teams.com","oidc:aud":"nia-teams-workload",
      "oidc:sub":[$sub,($sub+":elevated")]}}}]}' > resident-trust.json
jq --arg sub "role:${ROLE_KEY}:elevated" \
  '.statement[0].condition.string_equal["oidc:sub"]=$sub' \
  resident-trust.json > elevated-trust.json
```

Ordinary-tier `oidc:sub` is an array of the two exact subjects (so elevated sessions retain ordinary access). Elevated-tier `oidc:sub` is only the elevated string.

**Critical CAM six-segment QCS region code pitfall**:
- Do not rely on unverified condition keys such as `cvm:region = ap-beijing`—Tencent Cloud CVM evaluates authorization against six-segment resource QCS strings that use **short region codes** (`bj` for `ap-beijing`, `sh` for `ap-shanghai`, `gz` for `ap-guangzhou`, `hk` for `ap-hongkong`, `sg` for `ap-singapore`), while API request headers (`X-TC-Region` / `--region`) still take full region IDs (`ap-beijing`).
- Scope least-privilege custom policies directly via exact QCS resource paths, e.g. `qcs::cvm:bj:uin/<UIN>:instance/*` or `qcs::cvm:bj:uin/<UIN>:image/*`.

Provision the ordinary role, the elevated role, or both according to the enabled permission tiers, recording each returned numeric **`RoleId`** from `CreateRole` / `GetRole`:

```bash
tccli cam CreateRole --RoleName "$RESIDENT_ROLE" --ConsoleLogin 0 --SessionDuration 900 \
  --PolicyDocument "$(cat resident-trust.json)" --region ap-beijing
tccli cam CreatePolicy --PolicyName '<approved least-privilege read policy>' \
  --PolicyDocument '{"version":"2.0","statement":[{"effect":"allow","action":["name/cvm:DescribeInstances"],"resource":["qcs::cvm:bj:uin/<uin>:instance/*"]}]}' \
  --region ap-beijing
tccli cam AttachRolePolicy --AttachRoleName "$RESIDENT_ROLE" \
  --PolicyName '<approved least-privilege read policy>' --region ap-beijing

tccli cam CreateRole --RoleName "$ELEVATED_ROLE" --ConsoleLogin 0 --SessionDuration 900 \
  --PolicyDocument "$(cat elevated-trust.json)" --region ap-beijing
tccli cam AttachRolePolicy --AttachRoleName "$ELEVATED_ROLE" \
  --PolicyName '<approved elevated policy>' --region ap-beijing
```

Read back each provisioned role (recording numeric `RoleId`) and attached policy document:

```bash
tccli cam GetRole --RoleName "$RESIDENT_ROLE" --region ap-beijing
tccli cam ListAttachedRolePolicies --RoleName "$RESIDENT_ROLE" --Page 1 --Rp 200 --region ap-beijing
tccli cam GetRole --RoleName "$ELEVATED_ROLE" --region ap-beijing
tccli cam ListAttachedRolePolicies --RoleName "$ELEVATED_ROLE" --Page 1 --Rp 200 --region ap-beijing
```

## Sandbox commands & tccli OIDC authentication

`tccli` uses `TKE_REGION`, `TKE_PROVIDER_ID`, `TKE_ROLE_ARN`, and
`TKE_WEB_IDENTITY_TOKEN_FILE` to exchange the JWT via STS `AssumeRoleWithWebIdentity`
and sign service requests. STS credentials stay strictly in the `tccli` process memory;
do not export, print, or persist them, or use debug logging.

Use a regular token file in `/dev/shm` (tmpfs RAM), private mode `0600`, generated with
`nia role-token <roleKey>` for each command. The subshell templates below use `umask 077`,
`mktemp`, and an exit trap to delete the JWT immediately when the command exits (also
on handled HUP/INT/TERM). `/dev/shm` being `noexec` only prevents executing files there;
it does not prevent the SDK from opening and reading a token data file. A SIGKILL cannot
run cleanup; remove any orphaned private JWT file once the interrupted process is gone.

- Do **not** use bash process substitution `<(nia role-token ...)`: it supplies a
  one-shot `/dev/fd/*` pipe. `tencentcloud-sdk-python`'s `OIDCRoleArnCredential`
  reads `TKE_WEB_IDENTITY_TOKEN_FILE` during initialization and again on credential
  refresh (including the first exchange). Re-reading an exhausted pipe yields
  `InvalidParameter.ParamError: id_token is empty`.
- Do **not** point this variable directly at `/var/run/nia/mcp/token.<roleKey>`:
  that standing file always holds the Tier 1 ordinary token (`sub: role:<roleKey>`).
  During an approved elevation window, `nia role-token <roleKey>` instead selects
  the `:elevated` token from in-memory `NIA_ELEVATED_ROLE_TOKENS`.
- **Assumed-role ARN pitfall**: `sts GetCallerIdentity` returns the numeric `RoleId`,
  not `RoleName` (`qcs::sts:<UIN>:assumed-role/<RoleId>` or
  `.../<RoleId>/<RoleSessionName>`). Compare the exact ID from `cam GetRole`.

## Local live verification

On the **provisioning administrator workstation** (which already has `tccli` per prerequisites), use a private `0600` `role-response.json` containing the role PUT response (note that Nia Teams trims leading/trailing whitespace on `systemPrompt` and `elevationPrompt` when storing; compare `.strip()` on readback).
The `TKE_*` variables select OIDC credentials rather than administrator CLI auth; do not pass profile credentials or explicit secret-key flags. This helper requires `/dev/shm` tmpfs on the verification host; on a non-Linux workstation use its approved private RAM-backed temporary directory instead. Verify the 2×2 token exchange matrix and both positive/negative regional resource boundaries:

```bash
verify_cam() (
  set -eu; set +x
  umask 077
  T=$(mktemp /dev/shm/nia-oidc.XXXXXX)
  trap 'rm -f "$T"' EXIT
  trap 'exit 1' HUP INT TERM
  jq -er --arg field "$1" '.tokens[$field] | select(type == "string" and length > 0)' \
    role-response.json > "$T"
  IDENTITY=$(TKE_REGION=ap-beijing TKE_PROVIDER_ID=NiaTeamsWorkload \
    TKE_ROLE_ARN="$2" TKE_WEB_IDENTITY_TOKEN_FILE="$T" \
    tccli sts GetCallerIdentity --region ap-beijing)
  printf '%s\n' "$IDENTITY" | jq -e --arg roleId "$3" \
    '.Type == "CAMRole" and ((.Arn | split("assumed-role/")[1] | split("/")[0]) == $roleId)'
)
# Ordinary tier enabled: expect success.
verify_cam roleToken "$RESIDENT_ARN" "$RESIDENT_ROLE_ID"
# Elevated tier enabled: ordinary token must be denied by elevated role trust.
verify_cam roleToken "$ELEVATED_ARN" "$ELEVATED_ROLE_ID"
# Elevated tier enabled: expect success (and test ordinary role if both tiers are enabled).
verify_cam elevatedRoleToken "$ELEVATED_ARN" "$ELEVATED_ROLE_ID"
verify_cam elevatedRoleToken "$RESIDENT_ARN" "$RESIDENT_ROLE_ID"
```

Also run non-mutating service probes against allowed in-region resources (expect allow) and an out-of-region or out-of-scope action (expect `UnauthorizedOperation`). Remove `role-response.json` after checks.

Sources: [CAM OIDC Role SSO](https://www.tencentcloud.com/document/product/598/58323),
[CreateOIDCConfig](https://www.tencentcloud.com/document/product/598/47115),
[STS AssumeRoleWithWebIdentity](https://www.tencentcloud.com/document/product/1150/49454).

## Role prompt templates

以下为虚构部署；保存前替换为已批准的账号 UIN、角色名、地域与资源范围。
仅启用普通权限时 `sessionElevationEnabled: false` 且 `elevationPrompt` 为空；启用提权权限时设 `sessionElevationEnabled: true` 并配置下方 `elevationPrompt`（若未启用普通权限，`systemPrompt` 只写受控范围与提权要求，不含常驻读取命令）。

### Ordinary tier — systemPrompt

`agent.ops-agent.tencent` 是腾讯云账号 UIN `100000000001` 的日常巡检身份，普通权限为只读 `ap-beijing` 的 CVM 实例列表。沙箱已预装 `tccli`；OIDC JWT 仅暂存于 `/dev/shm` 的 `0600` 文件，命令退出即删除，STS 凭证仅在 `tccli` 进程内存中使用：

```bash
(
  umask 077
  T=$(mktemp /dev/shm/nia-oidc.XXXXXX) || exit 1
  trap 'rm -f "$T"' EXIT
  trap 'exit 1' HUP INT TERM
  nia role-token agent.ops-agent.tencent > "$T" || exit 1
  TKE_REGION=ap-beijing TKE_PROVIDER_ID=NiaTeamsWorkload \
    TKE_ROLE_ARN=qcs::cam::uin/100000000001:roleName/acme-observer \
    TKE_WEB_IDENTITY_TOKEN_FILE="$T" \
    tccli cvm DescribeInstances --region ap-beijing --Limit 10
)
```

（若同时启用提权权限，追加一句：）重启 `ap-beijing` 的 CVM 实例 `ins-00000001` 前，先说明目标对象、动作和副作用，再调用 `request_session_elevation`。

### Elevated tier only — systemPrompt

`agent.ops-agent.tencent` 是腾讯云账号 UIN `100000000001` 的受控运维身份，提权后允许重启 `ap-beijing` 的 CVM 实例 `ins-00000001`。日常无常驻权限。执行上述操作前先说明目标对象、动作和副作用，调用 `request_session_elevation`。

### Elevated tier — elevationPrompt

已批准重启腾讯云账号 UIN `100000000001` 在 `ap-beijing` 的 CVM 实例 `ins-00000001`。通过 `nia role-token agent.ops-agent.tencent` 获取当前提权身份；JWT 文件退出即删除，STS 凭证不落盘：

```bash
(
  umask 077
  T=$(mktemp /dev/shm/nia-oidc.XXXXXX) || exit 1
  trap 'rm -f "$T"' EXIT
  trap 'exit 1' HUP INT TERM
  nia role-token agent.ops-agent.tencent > "$T" || exit 1
  TKE_REGION=ap-beijing TKE_PROVIDER_ID=NiaTeamsWorkload \
    TKE_ROLE_ARN=qcs::cam::uin/100000000001:roleName/acme-operator \
    TKE_WEB_IDENTITY_TOKEN_FILE="$T" \
    tccli cvm RebootInstances --region ap-beijing --InstanceIds '["ins-00000001"]'
)
```
