# Tencent Cloud CAM OIDC

Use Bash, `jq`, `curl`, OpenSSL, and a current `tccli` (`>= 3.1.197`) in the administrator environment.
Administrator credentials remain on the local machine. Confirm the active CLI profile and root account UIN via `tccli sts GetCallerIdentity` before writes; UIN is not APPID.
Target Agent sandbox commands below require only `python3` (standard library `urllib`, `hashlib`, `hmac`) and `nia`—neither `tccli` nor `tencentcloud-sdk-python` needs to be preinstalled inside the target Agent sandbox.
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

## Sandbox commands & zero-dependency TC3 signing

- `sts.tencentcloudapi.com` `AssumeRoleWithWebIdentity` (`X-TC-Version: 2018-08-13`) uses header `Authorization: SKIP` and takes `RoleArn` in role-name form: `qcs::cam::uin/<UIN>:roleName/<RoleName>`.
- **Assumed-role ARN pitfall**: `sts GetCallerIdentity` returns `Arn` using the **numeric `RoleId`**, not `RoleName` (`qcs::sts:<UIN>:assumed-role/<RoleId>` or `.../<RoleId>/<RoleSessionName>`). Always match `RoleId` from `cam GetRole` when asserting caller identity.
- Subsequent Tencent Cloud API 3.0 calls sign requests with `TC3-HMAC-SHA256` using the temporary `TmpSecretId`, `TmpSecretKey`, and header `X-TC-Token: <Token>` in Python 3 standard library—keeping credentials strictly in process memory.

## Local live verification

Use a private `0600` `role-response.json` containing the role PUT response (note that Nia Teams trims leading/trailing whitespace on `systemPrompt` and `elevationPrompt` when storing; compare `.strip()` on readback).
Verify the 2×2 token exchange matrix and both positive/negative regional resource boundaries:

```bash
verify_cam() (
  set -eu; set +x
  ROLE_ARN="$2" EXPECTED_ROLE_ID="$3" FIELD="$1" python3 -I - <<'PY'
import datetime, hashlib, hmac, json, os, pathlib, time, urllib.error, urllib.request

jwt = json.loads(pathlib.Path("role-response.json").read_text())["tokens"][os.environ["FIELD"]]
req_body = json.dumps({
    "ProviderId": "NiaTeamsWorkload", "WebIdentityToken": jwt,
    "RoleArn": os.environ["ROLE_ARN"], "RoleSessionName": "nia-verification", "DurationSeconds": 900
}, separators=(",", ":")).encode()
req = urllib.request.Request("https://sts.tencentcloudapi.com", data=req_body, headers={
    "Content-Type": "application/json; charset=utf-8", "Authorization": "SKIP",
    "X-TC-Action": "AssumeRoleWithWebIdentity", "X-TC-Version": "2018-08-13",
    "X-TC-Timestamp": str(int(time.time())), "X-TC-Region": "ap-beijing",
}, method="POST")
try:
    sts = json.load(urllib.request.urlopen(req, timeout=30))["Response"]
except urllib.error.HTTPError as exc:
    raise SystemExit(f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}") from None
if "Error" in sts:
    raise SystemExit(f"{sts['Error']['Code']}: {sts['Error']['Message']}")
cred = sts["Credentials"]

host, service, body = "sts.tencentcloudapi.com", "sts", b"{}"
ts = str(int(time.time()))
date = datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc).strftime("%Y-%m-%d")
ct = "application/json; charset=utf-8"
canon = f"POST\n/\n\ncontent-type:{ct}\nhost:{host}\n\ncontent-type;host\n{hashlib.sha256(body).hexdigest()}"
scope = f"{date}/{service}/tc3_request"
s2s = f"TC3-HMAC-SHA256\n{ts}\n{scope}\n{hashlib.sha256(canon.encode()).hexdigest()}"
sign = lambda k, m: hmac.new(k, m.encode(), hashlib.sha256).digest()
sig = hmac.new(sign(sign(sign(("TC3" + cred["TmpSecretKey"]).encode(), date), service), "tc3_request"), s2s.encode(), hashlib.sha256).hexdigest()
id_req = urllib.request.Request(f"https://{host}", data=body, headers={
    "Content-Type": ct, "Host": host, "X-TC-Action": "GetCallerIdentity", "X-TC-Version": "2018-08-13",
    "X-TC-Timestamp": ts, "X-TC-Region": "ap-beijing", "X-TC-Token": cred["Token"],
    "Authorization": f"TC3-HMAC-SHA256 Credential={cred['TmpSecretId']}/{scope}, SignedHeaders=content-type;host, Signature={sig}",
}, method="POST")
ident = json.load(urllib.request.urlopen(id_req, timeout=30))["Response"]
assert ident["Type"] == "CAMRole" and f"assumed-role/{os.environ['EXPECTED_ROLE_ID']}" in ident["Arn"], ident
print("Verified:", ident["AccountId"], ident["Arn"])
PY
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

`agent.ops-agent.tencent` 是腾讯云账号 UIN `100000000001` 的日常巡检身份，普通权限为只读 `ap-beijing` 的 CVM 实例列表（不依赖 `tccli`，仅用 Python 3 标准库与 `nia` 在内存中换取短期凭证并完成 TC3 签名）：

```bash
python3 -I - <<'PY'
import datetime, hashlib, hmac, json, subprocess, time, urllib.error, urllib.request

ROLE_ARN = "qcs::cam::uin/100000000001:roleName/acme-observer"
REGION = "ap-beijing"
token = subprocess.check_output(["nia", "role-token", "agent.ops-agent.tencent"], text=True, timeout=30).strip()

def post(host, body, headers):
    try:
        with urllib.request.urlopen(urllib.request.Request(f"https://{host}", data=body, headers=headers, method="POST"), timeout=30) as r:
            res = json.load(r)["Response"]
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}") from None
    if "Error" in res:
        raise RuntimeError(f"{res['Error']['Code']}: {res['Error']['Message']}")
    return res

sts_body = json.dumps({"ProviderId": "NiaTeamsWorkload", "WebIdentityToken": token,
                       "RoleArn": ROLE_ARN, "RoleSessionName": "ops-agent-cvm", "DurationSeconds": 900}, separators=(",", ":")).encode()
cred = post("sts.tencentcloudapi.com", sts_body, {
    "Content-Type": "application/json; charset=utf-8", "Authorization": "SKIP",
    "X-TC-Action": "AssumeRoleWithWebIdentity", "X-TC-Version": "2018-08-13",
    "X-TC-Timestamp": str(int(time.time())), "X-TC-Region": REGION,
})["Credentials"]

def tc3_call(service, action, version, region, payload):
    host, ct = f"{service}.tencentcloudapi.com", "application/json; charset=utf-8"
    body = json.dumps(payload, separators=(",", ":")).encode()
    ts = str(int(time.time()))
    date = datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc).strftime("%Y-%m-%d")
    canon = f"POST\n/\n\ncontent-type:{ct}\nhost:{host}\n\ncontent-type;host\n{hashlib.sha256(body).hexdigest()}"
    scope = f"{date}/{service}/tc3_request"
    s2s = f"TC3-HMAC-SHA256\n{ts}\n{scope}\n{hashlib.sha256(canon.encode()).hexdigest()}"
    sign = lambda k, m: hmac.new(k, m.encode(), hashlib.sha256).digest()
    sig = hmac.new(sign(sign(sign(("TC3" + cred["TmpSecretKey"]).encode(), date), service), "tc3_request"), s2s.encode(), hashlib.sha256).hexdigest()
    return post(host, body, {
        "Content-Type": ct, "Host": host, "X-TC-Action": action, "X-TC-Version": version,
        "X-TC-Timestamp": ts, "X-TC-Region": region, "X-TC-Token": cred["Token"],
        "Authorization": f"TC3-HMAC-SHA256 Credential={cred['TmpSecretId']}/{scope}, SignedHeaders=content-type;host, Signature={sig}",
    })

print(json.dumps(tc3_call("cvm", "DescribeInstances", "2017-03-12", REGION, {"Limit": 10}), ensure_ascii=False, indent=2))
PY
```

（若同时启用提权权限，追加一句：）重启 `ap-beijing` 的 CVM 实例 `ins-00000001` 前，先说明目标对象、动作和副作用，再调用 `request_session_elevation`。

### Elevated tier only — systemPrompt

`agent.ops-agent.tencent` 是腾讯云账号 UIN `100000000001` 的受控运维身份，提权后允许重启 `ap-beijing` 的 CVM 实例 `ins-00000001`。日常无常驻权限。执行上述操作前先说明目标对象、动作和副作用，调用 `request_session_elevation`。

### Elevated tier — elevationPrompt

已批准重启腾讯云账号 UIN `100000000001` 在 `ap-beijing` 的 CVM 实例 `ins-00000001`。调用 `nia role-token agent.ops-agent.tencent` 获取提权身份并将 `ROLE_ARN` 设为 `qcs::cam::uin/100000000001:roleName/acme-operator`：

```bash
python3 -I - <<'PY'
import datetime, hashlib, hmac, json, subprocess, time, urllib.error, urllib.request

ROLE_ARN = "qcs::cam::uin/100000000001:roleName/acme-operator"
REGION = "ap-beijing"
token = subprocess.check_output(["nia", "role-token", "agent.ops-agent.tencent"], text=True, timeout=30).strip()

def post(host, body, headers):
    try:
        with urllib.request.urlopen(urllib.request.Request(f"https://{host}", data=body, headers=headers, method="POST"), timeout=30) as r:
            res = json.load(r)["Response"]
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}") from None
    if "Error" in res:
        raise RuntimeError(f"{res['Error']['Code']}: {res['Error']['Message']}")
    return res

sts_body = json.dumps({"ProviderId": "NiaTeamsWorkload", "WebIdentityToken": token,
                       "RoleArn": ROLE_ARN, "RoleSessionName": "ops-agent-cvm-reboot", "DurationSeconds": 900}, separators=(",", ":")).encode()
cred = post("sts.tencentcloudapi.com", sts_body, {
    "Content-Type": "application/json; charset=utf-8", "Authorization": "SKIP",
    "X-TC-Action": "AssumeRoleWithWebIdentity", "X-TC-Version": "2018-08-13",
    "X-TC-Timestamp": str(int(time.time())), "X-TC-Region": REGION,
})["Credentials"]

def tc3_call(service, action, version, region, payload):
    host, ct = f"{service}.tencentcloudapi.com", "application/json; charset=utf-8"
    body = json.dumps(payload, separators=(",", ":")).encode()
    ts = str(int(time.time()))
    date = datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc).strftime("%Y-%m-%d")
    canon = f"POST\n/\n\ncontent-type:{ct}\nhost:{host}\n\ncontent-type;host\n{hashlib.sha256(body).hexdigest()}"
    scope = f"{date}/{service}/tc3_request"
    s2s = f"TC3-HMAC-SHA256\n{ts}\n{scope}\n{hashlib.sha256(canon.encode()).hexdigest()}"
    sign = lambda k, m: hmac.new(k, m.encode(), hashlib.sha256).digest()
    sig = hmac.new(sign(sign(sign(("TC3" + cred["TmpSecretKey"]).encode(), date), service), "tc3_request"), s2s.encode(), hashlib.sha256).hexdigest()
    return post(host, body, {
        "Content-Type": ct, "Host": host, "X-TC-Action": action, "X-TC-Version": version,
        "X-TC-Timestamp": ts, "X-TC-Region": region, "X-TC-Token": cred["Token"],
        "Authorization": f"TC3-HMAC-SHA256 Credential={cred['TmpSecretId']}/{scope}, SignedHeaders=content-type;host, Signature={sig}",
    })

print(json.dumps(tc3_call("cvm", "RebootInstances", "2017-03-12", REGION, {"InstanceIds": ["ins-00000001"]}), ensure_ascii=False, indent=2))
PY
```
