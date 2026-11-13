#!/usr/bin/env python3
"""Check the documentation layers, local links, PNGs and fenced syntax.

Requires Python 3, PyYAML, Bash and jq. No cloud calls or administrative writes.
"""
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile
from urllib.parse import unquote
import zlib

import yaml

ROOT = Path(__file__).resolve().parents[1]
MARKDOWN = {
    'README.md', 'README_CN.md', 'AGENTS.md', 'docs/SPECIFICATION.md',
    'skills/cloud-oidc/README.md', 'skills/cloud-oidc/README_CN.md',
    'skills/cloud-oidc/SKILL.md',
    *{f'skills/cloud-oidc/references/{p}.md' for p in ('aliyun', 'tencentcloud', 'kubernetes')},
}
MARKDOWN |= {'skills/routine-webhook/SKILL.md', *{f'packages/routine-webhook/{p}' for p in (
    'README.md', 'README_CN.md', 'AGENTS.md', 'docs/SPECIFICATION.md',
    'docs/assets/README.md', 'skills/routine-webhook/SKILL.md')}}
IMAGES = {'agent-connect.png', 'group-chat-overview.png', 'taskbar-elevation.png'}
actual = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*.md') if not {'.git', 'node_modules', 'dist'} & set(p.parts)}
assert actual == MARKDOWN, f'Markdown layout differs: {actual ^ MARKDOWN}'
assert not (ROOT / 'docs/cloud-oidc').exists(), 'Duplicate human guide directory'
assert (ROOT / 'LICENSE').is_file(), 'Missing license'
skill_root = ROOT / 'skills/cloud-oidc'
assert {p.relative_to(skill_root).as_posix() for p in skill_root.rglob('*') if p.is_file()} == {
    'README.md', 'README_CN.md', 'SKILL.md',
    'references/aliyun.md', 'references/tencentcloud.md', 'references/kubernetes.md',
}, 'Skill directory files differ'
counts = dict(markdown=0, shell=0, json=0, yaml=0, links=0, images=0, trust=0)


def check_png(path):
    """Validate PNG chunks/CRC and decoded scanline size without image dependencies."""
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', f'Invalid PNG: {path}'
    offset, chunks, compressed = 8, [], bytearray()
    width = height = depth = color = interlace = None
    while offset < len(data):
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack('>I', data[offset + 8 + length:offset + 12 + length])[0]
        assert zlib.crc32(kind + payload) == crc, f'PNG CRC: {path}'
        chunks.append(kind)
        if kind == b'IHDR':
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', payload)
            assert compression == filtering == 0
        if kind == b'IDAT':
            compressed.extend(payload)
        offset += 12 + length
        if kind == b'IEND':
            break
    assert chunks[0] == b'IHDR' and chunks[-1] == b'IEND' and offset == len(data)
    assert depth == 8 and color in (2, 6) and interlace == 0, f'Unsupported PNG: {path}'
    channels = 3 if color == 2 else 4
    assert len(zlib.decompress(compressed)) == height * (1 + width * channels)
    assert width % 2 == height % 2 == 0 and width >= 1600 and height >= 400, f'2x geometry: {path}'
    print(f'PNG {path.relative_to(ROOT)}: {width}x{height}')
    counts['images'] += 1


assert {p.name for p in (ROOT / 'docs/assets').glob('*.png')} == IMAGES
assert {p.name for p in (ROOT / 'packages/routine-webhook/docs/assets').glob('*.png')} == {'agent-connect.png', 'routine-topic-chat.png'}
for assets in ('docs/assets', 'packages/routine-webhook/docs/assets'):
    for image in sorted((ROOT / assets).glob('*.png')):
        check_png(image)

AI_CONTRACT_FILES = {
    'skills/cloud-oidc/SKILL.md',
    'skills/cloud-oidc/references/aliyun.md',
    'skills/cloud-oidc/references/tencentcloud.md',
    'skills/cloud-oidc/references/kubernetes.md',
}

for relative in sorted(MARKDOWN):
    path = ROOT / relative
    text = path.read_text()
    counts['markdown'] += 1
    assert not re.search(r'^title\s*:', text, re.M), f'Unexpected title metadata: {path}'
    if path.name == 'SKILL.md':
        assert text.startswith('---\n'), f'Missing skill frontmatter: {path}'
    if text.startswith('---\n'):
        front = yaml.safe_load(text.split('---\n', 2)[1])
        assert relative in {'skills/cloud-oidc/SKILL.md', 'skills/routine-webhook/SKILL.md', 'packages/routine-webhook/skills/routine-webhook/SKILL.md'}
        assert set(front) == {'name', 'description'} and front['name'] == path.parent.name
        assert isinstance(front['description'], str) and len(front['description']) > 100
        assert not re.search(r'[\u3400-\u9fff]', front['description']), f'English description required: {path}'
    assert text.count('```') % 2 == 0, f'Unclosed fence: {path}'
    for language, block in re.findall(r'^```([\w-]+)\n(.*?)^```', text, re.M | re.S):
        if language in ('bash', 'sh', 'shell'):
            shell = 'sh' if language == 'sh' else 'bash'
            result = subprocess.run([shell, '-n'], input=block, text=True, capture_output=True)
            assert result.returncode == 0, f'{path}: {result.stderr}'
            counts['shell'] += 1
        elif language == 'json':
            json.loads(block)
            counts['json'] += 1
        elif language in ('yaml', 'yml'):
            for doc in yaml.safe_load_all(block):
                assert isinstance(doc, dict), f'{path}: expected YAML mapping'
                if 'kind' in doc:
                    assert doc.get('apiVersion') == 'rbac.authorization.k8s.io/v1'
            counts['yaml'] += 1
    for target in re.findall(r'\]\(([^\s)]+)\)', text):
        if re.match(r'[a-z]+:', target) or target.startswith('#'):
            continue
        destination = (path.parent / unquote(target.split('#')[0])).resolve()
        assert destination.is_relative_to(ROOT) and (destination.is_file() or destination.is_dir()), f'{path}: broken {target}'
        # Human cloud guides intentionally reference the shared screenshot directory.
        if relative in AI_CONTRACT_FILES or relative == 'skills/routine-webhook/SKILL.md':
            installed_root = ROOT / 'skills' / Path(relative).parts[1]
            assert destination.is_relative_to(installed_root) and destination.is_file(), f'Installed skill external dependency: {target}'
        counts['links'] += 1
    if relative in ('README.md', 'README_CN.md', 'packages/routine-webhook/README.md', 'packages/routine-webhook/README_CN.md'):
        for word in ('无'+'缝', '绝'+'不', '一'+'律', '严'+'格', '精'+'确', '完'+'整', '确'+'保', '自'+'动', '直'+'接'):
            assert word not in text, f'Prose strengthener: {path}: {word}'
    if relative in ('README.md', 'README_CN.md'):
        assert text.startswith('# Nia Teams Connect Skills\n')
        assert 'skills/cloud-oidc/README' in text and 'packages/routine-webhook/README' in text
        if relative == 'README.md':
            assert not re.search(r'[\u3400-\u9fff]', text), 'Root English README must be English only'
        else:
            assert all(re.search(r'[\u3400-\u9fff]', h) for h in re.findall(r'^## (.+)', text, re.M)), 'Chinese README headings required'
    if relative == 'skills/cloud-oidc/README.md':
        assert text.startswith('# Zero-Trust Cloud Access for Agents (`cloud-oidc`)\n')
    if relative == 'skills/cloud-oidc/README_CN.md':
        assert text.startswith('# Agent 零信任云权限接入（`cloud-oidc`）\n')
    if relative in ('skills/cloud-oidc/README.md', 'skills/cloud-oidc/README_CN.md'):
        image_links = set(re.findall(r'!\[[^\]]*\]\(\.\./\.\./docs/assets/([^)]*)\)', text))
        assert image_links == IMAGES, f'{path}: required screenshots differ'
        assert text.index('npx skills add nia-teams/connect-skills --skill cloud-oidc') < text.index('\n## ')
        assert len(re.findall(r'^## ', text, re.M)) == 5

skill = (skill_root / 'SKILL.md').read_text()
assert 70 <= len(skill.splitlines()) <= 90
assert re.findall(r'^## (.+)$', skill, re.M) == [
    'Scope & References', 'Agent Pairing & Authorization-Role API',
    'Identity Matrix & Two-Tier Permissions', 'Two-Phase Role Prompt Authoring',
    'Provisioning & Live Verification',
]
assert 40 <= len((ROOT / 'AGENTS.md').read_text().splitlines()) <= 65
assert len((ROOT / 'packages/routine-webhook/AGENTS.md').read_text().splitlines()) < 65
assert 40 <= len((ROOT / 'skills/routine-webhook/SKILL.md').read_text().splitlines()) <= 85
for relative in ('skills/routine-webhook/SKILL.md', 'docs/SPECIFICATION.md'):
    assert (ROOT / relative).read_bytes() == (ROOT / 'packages/routine-webhook' / relative).read_bytes(), f'Out of sync: {relative}'
tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
for relative in filter(None, tracked):
    data = (ROOT / relative).read_bytes().lower()
    for forbidden in (b'bai' + b'chuan', b'bc' + b'-inner', b'internal' + b'.nia-teams', b'nia.teams' + b'.bc'):
        assert forbidden not in data, f'Public identity hygiene: {relative}'

# Execute only local jq trust-document generators, isolated in a temporary directory.
for platform in ('aliyun', 'tencentcloud'):
    text = (skill_root / f'references/{platform}.md').read_text()
    block = next(b for lang, b in re.findall(r'^```(\w+)\n(.*?)^```', text, re.M | re.S)
                 if lang == 'bash' and '> resident-trust.json' in b)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(['bash', '-euc', block], cwd=tmp, check=True)
        resident = json.loads((Path(tmp) / 'resident-trust.json').read_text())
        elevated = json.loads((Path(tmp) / 'elevated-trust.json').read_text())
    if platform == 'aliyun':
        r = resident['Statement'][0]['Condition']['StringEquals']
        e = elevated['Statement'][0]['Condition']['StringEquals']
        assert resident['Statement'][0]['Action'] == 'sts:AssumeRole'
        assert resident['Statement'][0]['Principal'] == {
            'Federated': ['acs:ram::<accountId>:oidc-provider/NiaTeamsWorkload']
        }
    else:
        r = resident['statement'][0]['condition']['string_equal']
        e = elevated['statement'][0]['condition']['string_equal']
        assert resident['statement'][0]['action'] == 'name/sts:AssumeRoleWithWebIdentity'
        assert resident['statement'][0]['principal'] == {
            'federated': ['qcs::cam::uin/<uin>:oidc-provider/NiaTeamsWorkload']
        }
    assert e['oidc:sub'] == 'role:agent.<agentSlug>.<name>:elevated'
    assert r['oidc:sub'] == ['role:agent.<agentSlug>.<name>', 'role:agent.<agentSlug>.<name>:elevated']
    for condition in (r, e):
        assert condition['oidc:iss'] == 'https://nia-teams.com'
        assert condition['oidc:aud'] == 'nia-teams-workload'
    counts['trust'] += 1

# Exercise the documented helper itself with a local tccli stub, never cloud auth.
tencent = (skill_root / 'references/tencentcloud.md').read_text()
verification = next(b for lang, b in re.findall(r'^```(\w+)\n(.*?)^```', tencent, re.M | re.S)
                    if lang == 'bash' and b.startswith('verify_cam() ('))
helper = verification.split('\n# Ordinary tier enabled:', 1)[0]
assert 'mktemp /dev/shm/nia-oidc.XXXXXX' in helper
with tempfile.TemporaryDirectory() as tmp:
    directory = Path(tmp)
    (directory / 'role-response.json').write_text(json.dumps({
        'tokens': {'roleToken': 'ordinary-test-jwt', 'elevatedRoleToken': 'elevated-test-jwt'}
    }))
    stub = r'''
mktemp() { command mktemp "$PWD/token.XXXXXX"; }
tccli() {
  printf '%s' "$TKE_WEB_IDENTITY_TOKEN_FILE" > token-path
  [[ "$*" == 'sts GetCallerIdentity --region ap-beijing' ]] || return 90
  [[ "$TKE_REGION" == ap-beijing && "$TKE_PROVIDER_ID" == NiaTeamsWorkload ]] || return 91
  [[ $(stat -c %a "$TKE_WEB_IDENTITY_TOKEN_FILE") == 600 ]] || return 92
  local jwt again
  jwt=$(cat "$TKE_WEB_IDENTITY_TOKEN_FILE")
  again=$(cat "$TKE_WEB_IDENTITY_TOKEN_FILE")
  [[ "$jwt" == "$again" && "$jwt" == "$EXPECTED_JWT" ]] || return 93
  [[ "$TKE_ROLE_ARN" == "$EXPECTED_ARN" ]] || return 94
  [[ "$MOCK_FAILURE" == 0 ]] || return 95
  printf '%s\n' "$MOCK_IDENTITY"
}
'''
    cases = [
        ('ordinary', 'roleToken', '12345', 'CAMRole', '12345', '', False, True),
        ('elevated-session', 'elevatedRoleToken', '12345', 'CAMRole', '12345', '/session', False, True),
        ('wrong-id', 'roleToken', '12345', 'CAMRole', '123456', '', False, False),
        ('wrong-type', 'roleToken', '12345', 'User', '12345', '', False, False),
        ('exchange-denied', 'roleToken', '12345', 'CAMRole', '12345', '', True, False),
        ('missing-token', 'missing', '12345', 'CAMRole', '12345', '', False, False),
    ]
    for name, field, expected_id, identity_type, actual_id, suffix, failure, success in cases:
        identity = json.dumps({'Type': identity_type,
                               'Arn': f'qcs::sts:100000000001:assumed-role/{actual_id}{suffix}'})
        env = dict(EXPECTED_JWT=('elevated-test-jwt' if field == 'elevatedRoleToken' else 'ordinary-test-jwt'),
                   EXPECTED_ARN='qcs::cam::uin/100000000001:roleName/test',
                   MOCK_FAILURE=str(int(failure)), MOCK_IDENTITY=identity)
        # Pass mock data as positional arguments to avoid interpolating shell source.
        setup = '\n'.join(f'export {key}="${index}"' for index, key in enumerate(env, 1))
        result = subprocess.run(['bash', '-c', stub + setup + '\n' + helper +
                                 f'\nverify_cam {field} "$EXPECTED_ARN" {expected_id}',
                                 'verify-cam-test', *env.values()], cwd=tmp, text=True, capture_output=True)
        expected_status = 0 if success else (95 if failure else (4 if field == 'missing' else 1))
        assert result.returncode == expected_status, f'verify_cam {name}: status={result.returncode}: {result.stderr}'
        assert not list(directory.glob('token.*')), f'verify_cam {name}: token not cleaned up'
    print(f'verify_cam: {len(cases)} local behavior checks passed')

for path in (skill_root / 'references').glob('*.md'):
    text = path.read_text()
    for section in ('Ordinary tier — systemPrompt', 'Elevated tier only — systemPrompt'):
        prompt = text.split('### ' + section, 1)[1].split('\n### ', 1)[0]
        assert 'acme-operator' not in prompt, f'Elevated ARN in resident prompt: {path}'
    templates = text.split('## Role prompt templates', 1)[1]
    disallowed = ['set -eu', 'set +x',
                  'GetCallerIdentity', 'auth can-i',
                  'newly launched shell', '新启动的 shell']
    if path.stem != 'tencentcloud':
        disallowed.extend(['AssumeRoleWithWebIdentity', 'umask', 'mktemp', 'trap '])
    for boilerplate in disallowed:
        assert boilerplate not in templates, f'Role prompt noise: {path}: {boilerplate}'
    assert 'request_session_elevation' in templates
    if path.stem == 'aliyun':
        assert 'sls GetLogs' in templates and 'sae RestartApplication' in templates
    elif path.stem == 'tencentcloud':
        assert 'DescribeInstances' in templates and 'RebootInstances' in templates
        assert 'TC3-HMAC-SHA256' not in templates
        for requirement in ('tccli cvm', 'TKE_REGION', 'TKE_PROVIDER_ID', 'TKE_ROLE_ARN',
                            'TKE_WEB_IDENTITY_TOKEN_FILE', 'mktemp /dev/shm/nia-oidc.XXXXXX',
                            'umask 077', 'trap \'rm -f \"$T\"\' EXIT'):
            assert templates.count(requirement) == 2, f'Missing private OIDC lifecycle: {requirement}'
    else:
        assert 'get pods,deployments' in templates and 'logs deployment/payments-api' in templates
        assert 'rollout restart deployment/payments-api' in templates
    elevated = text.split('### Elevated tier — elevationPrompt', 1)[1]
    assert 'nia role-token' in elevated
    assert 'acme-operator' in elevated or 'nia-workload-operator' in elevated

print('PASS ' + ', '.join(f'{k}={v}' for k, v in counts.items()))
print('Cloud operations: not executed; local syntax, images and trust JSON only.')
