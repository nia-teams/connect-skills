# Kubernetes OIDC RBAC

Use an administrator's authenticated local `kubectl` to inspect the intended context, API endpoint,
CA, existing authentication configuration and RBAC. Distribute the cluster endpoint and CA separately from administrator authentication. Provision only the reviewed namespace and operations.

## API server authentication

An existing API server must accept Nia Teams OIDC tokens:

```text
--oidc-issuer-url=https://nia-teams.com
--oidc-client-id=nia-teams-workload
--oidc-username-claim=sub
--oidc-username-prefix=-
--oidc-groups-claim=groups
--oidc-groups-prefix=
```

The `--oidc-username-prefix=-` flag is optional when using Group bindings. Without `-`, Kubernetes
defaults to an issuer-prefixed username (`https://nia-teams.com#role:agent.<agentSlug>.<name>`),
whereas an empty `--oidc-groups-prefix=` preserves the exact group strings below regardless of
username prefix settings. Group bindings are therefore the primary pattern. For structured authentication
configuration, configure equivalent claims/prefixes; do not combine mutually exclusive mechanisms.
Inspect the effective mapping rather than assuming API-server defaults. API-server changes may
restart control-plane components and affect other clients: plan and obtain separate approval.
If a managed cluster does not support this issuer/claim mapping, stop; RBAC cannot add OIDC authentication.
Ensure the API server can retrieve discovery/JWKS and the Agent can reach the cluster endpoint.

```bash
kubectl config current-context
kubectl cluster-info
kubectl get configmap kube-root-ca.crt -n kube-public -o jsonpath='{.data.ca\.crt}'
kubectl get rolebindings,roles -n '<namespace>'
kubectl get clusterrolebindings,clusterroles
```

## Namespace-scoped Group bindings (recommended)

Group bindings work identically whether `--oidc-username-prefix` is `-` or the Kubernetes default
(`https://nia-teams.com#`), and elevated role tokens carry both the resident group
`role:agent.<agentSlug>.<name>` and the elevated group `nia:elevated:role:agent.<agentSlug>.<name>`.
Replace `<agentSlug>`, `<name>`, `<namespace>` and object names with confirmed values. This example
uses inspection of workloads and an elevated deployment restart/scale scope, not cluster-admin.
Run `kubectl diff -f nia-rbac.yaml`, review changes, then `kubectl apply -f nia-rbac.yaml`.
Include the ordinary reader objects, the elevated operator objects, or both according to the enabled permission tiers. Save the following as that file:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: nia-workload-reader
  namespace: <namespace>
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nia-workload-reader
  namespace: <namespace>
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: nia-workload-reader
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: role:agent.<agentSlug>.<name>
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: nia-workload-operator
  namespace: <namespace>
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "deployments/scale"]
    verbs: ["get", "list", "watch", "patch", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nia-workload-operator
  namespace: <namespace>
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: nia-workload-operator
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: nia:elevated:role:agent.<agentSlug>.<name>
```

Read back `kubectl get roles,rolebindings -n '<namespace>' -o yaml` after apply.
Bindings are additive: inspect other bindings that may already grant this identity access.
When only the elevated tier is enabled, the operator Role is the complete approved elevated scope; add needed elevated read rules to it explicitly rather than installing a standing reader binding.

## User bindings and cluster-scoped alternatives

Use either reviewed Group bindings or User bindings, not both by default. When binding by `User`,
match the cluster's effective username prefix (`role:agent.<agentSlug>.<name>` when
`--oidc-username-prefix=-`, or `https://nia-teams.com#role:agent.<agentSlug>.<name>` with the
default prefix). Reader `User` bindings list both the ordinary and `:elevated` subjects:

```yaml
subjects:
  - kind: User
    apiGroup: rbac.authorization.k8s.io
    name: role:agent.<agentSlug>.<name>
  - kind: User
    apiGroup: rbac.authorization.k8s.io
    name: role:agent.<agentSlug>.<name>:elevated
```

Operator `User` bindings list only the elevated subject:

```yaml
subjects:
  - kind: User
    apiGroup: rbac.authorization.k8s.io
    name: role:agent.<agentSlug>.<name>:elevated
```

For multi-namespace or cluster-level scope, author a reviewed `ClusterRole` with exact rules and apply
it with `kubectl apply -f cluster-role.yaml`. A namespaced `RoleBinding` referencing that ClusterRole
limits its namespace-scoped permissions to that namespace. A `ClusterRoleBinding` grants its scope
cluster-wide; apply only after reviewing that expansion. Example elevated root-equivalent binding,
only for explicitly approved cluster administration:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: nia-approved-cluster-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: nia:elevated:role:agent.<agentSlug>.<name>
```

Use `kubectl apply -f cluster-binding.yaml`, then read back the exact ClusterRole and binding.
RBAC access to Secrets, `pods/exec`, workload creation, `bind`, `escalate`, or impersonation may enable
privilege escalation; granting those is a separate security decision.

## Sandbox authentication

Distribute only the approved HTTPS endpoint and trusted CA certificate, not client keys, bearer
credentials or administrator exec plugins. Because the local administrator does not write files into
the target Agent's sandbox directly, fetch the public cluster CA PEM (for example from
`kube-public/kube-root-ca.crt` when local kubeconfig omits `certificate-authority-data`) and embed it
inside the role prompt (`cat > /tmp/acme-ca.crt <<'EOF' ... EOF`), passing
`--certificate-authority=/tmp/acme-ca.crt`.
When the administrator's local kubeconfig uses `insecure-skip-tls-verify: true`,
an external CA file, or omits inline CA data, extract `<CLUSTER_CA_PEM>` with:

```bash
kubectl get configmap kube-root-ca.crt -n kube-public -o jsonpath='{.data.ca\.crt}'
```

Verify that this CA belongs to the approved API endpoint; do not copy insecure TLS settings.
`--kubeconfig=/dev/null` isolates calls from ambient kubeconfig state. The command form below refreshes
the token per invocation; an exec-credential kubeconfig is an alternative only with a correctly
implemented ExecCredential plugin wrapping `nia role-token` (raw JWT output is not ExecCredential JSON).

## Local live verification

Use the workload token fields from a private `0600` `role-response.json`.
Set `SERVER`, `CA_FILE`, and `NAMESPACE` to the actual approved endpoint, CA and namespace.

```bash
verify_rbac() {
  kubectl --kubeconfig=/dev/null --server="$SERVER" --certificate-authority="$CA_FILE" \
    --token="$(jq -er --arg field "$1" '.tokens[$field]' role-response.json)" \
    --namespace="$NAMESPACE" auth can-i "$2" "$3"
}
# Ordinary tier enabled: yes.
verify_rbac roleToken get pods
# Elevated tier enabled: no (ordinary token must not gain elevated write).
verify_rbac roleToken patch deployments
# Elevated tier enabled: yes.
verify_rbac elevatedRoleToken patch deployments
# Both tiers enabled: yes (elevated subject retains ordinary reads).
verify_rbac elevatedRoleToken get pods
# Scoped permissions: no outside the approved namespace/scope.
verify_rbac roleToken get secrets
```

Adapt probes to the approved rules, executing only calls applicable to the enabled tier(s).
`auth can-i` returns the RBAC decision without executing the operation.
When only the elevated tier is enabled, an authenticated ordinary token may retain Kubernetes discovery/self-review permissions,
but it must have none of the cloud/workload privileges being connected.
Read back all relevant bindings to account for RBAC's additive grants, then delete the private response.
Remove reviewed bindings for revocation; a prompt change alone cannot remove RBAC authorization.

Source: [Kubernetes OIDC authentication](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#openid-connect-tokens),
[RBAC authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/).

## Role prompt templates

以下为虚构部署；保存前替换为已批准的账号、角色、地域、资源与 endpoint/CA。
仅启用普通权限时 `sessionElevationEnabled: false` 且 `elevationPrompt` 为空；启用提权权限时设 `sessionElevationEnabled: true` 并配置下方 `elevationPrompt`（若未启用普通权限，`systemPrompt` 只写受控范围与提权要求，不含常驻读取命令）。

### Ordinary tier — systemPrompt

`agent.ops-agent.k8s-prod` 是 Kubernetes 集群 `acme-production` 的日常巡检身份，普通权限为只读 `production` namespace 的 Pod、日志和 Deployment。调用前先写入集群 CA 并携带角色 Token：

```bash
cat > /tmp/acme-ca.crt <<'EOF'
-----BEGIN CERTIFICATE-----
<CLUSTER_CA_PEM>
-----END CERTIFICATE-----
EOF
kubectl --kubeconfig=/dev/null --server=https://k8s.acme.example:6443 \
  --certificate-authority=/tmp/acme-ca.crt \
  --token="$(nia role-token agent.ops-agent.k8s-prod)" \
  --namespace=production get pods,deployments
kubectl --kubeconfig=/dev/null --server=https://k8s.acme.example:6443 \
  --certificate-authority=/tmp/acme-ca.crt \
  --token="$(nia role-token agent.ops-agent.k8s-prod)" \
  --namespace=production logs deployment/payments-api --tail=100
```

（若同时启用提权权限，追加一句：）重启 Deployment `payments-api` 前，先说明目标对象、动作和副作用，再调用 `request_session_elevation`。

### Elevated tier only — systemPrompt

`agent.ops-agent.k8s-prod` 是 Kubernetes 集群 `acme-production` 的受控运维身份，提权后允许重启 `production` namespace 的 Deployment `payments-api`。日常无常驻权限。执行上述操作前先说明目标对象、动作和副作用，调用 `request_session_elevation`。

### Elevated tier — elevationPrompt

已批准重启集群 `acme-production`、`production` namespace 的 Deployment `payments-api`。提权身份通过 `Group: nia:elevated:role:agent.ops-agent.k8s-prod`（`production/nia-workload-operator`）获得 Deployment 的 `patch` / `update` 权限：

```bash
cat > /tmp/acme-ca.crt <<'EOF'
-----BEGIN CERTIFICATE-----
<CLUSTER_CA_PEM>
-----END CERTIFICATE-----
EOF
kubectl --kubeconfig=/dev/null --server=https://k8s.acme.example:6443 \
  --certificate-authority=/tmp/acme-ca.crt \
  --token="$(nia role-token agent.ops-agent.k8s-prod)" \
  --namespace=production rollout restart deployment/payments-api
```
