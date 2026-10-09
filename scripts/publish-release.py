"""Publish a complete signed update channel, then make the release public."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from verify_portable_runtime import verify_portable

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'tangtianxu/MockInterview'

def prepare_assets(installer, version, notes, date):
    signature = installer.with_suffix(installer.suffix + '.sig').read_text().strip()
    if not signature:
        raise ValueError('Signed installer required')
    manifest = {'version': version, 'notes': notes, 'pub_date': date, 'platforms': {
        'windows-x86_64': {'signature': signature,
            'url': f'https://github.com/{REPOSITORY}/releases/download/v{version}/{installer.name}'}}}
    binary = installer.read_bytes()
    digest = hashlib.sha256(binary).hexdigest()
    return [(installer.name, binary, 'application/octet-stream'),
            (installer.name + '.sig', signature.encode(), 'text/plain'),
            ('SHA256SUMS.txt', f'{digest}  {installer.name}\n'.encode(), 'text/plain'),
            ('latest.json', json.dumps(manifest, ensure_ascii=False, indent=2).encode(), 'application/json')]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--notes-file', type=Path)
    parser.add_argument('--installer', type=Path)
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    if config['version'] != version or not config['bundle']['createUpdaterArtifacts']:
        raise SystemExit('Synchronize versions and enable signed updater artifacts first')
    tag = f'v{version}'
    installer = args.installer or ROOT / f'src-tauri/target/release/bundle/nsis/MockInterview_{version}_x64-setup.exe'
    verify_portable(installer.parents[2] / 'interview-cue.exe')
    notes = args.notes_file.read_text(encoding='utf-8').strip() if args.notes_file else ''
    if not notes and not args.dry_run:
        raise SystemExit('Publish requires --notes-file containing release notes')
    if args.dry_run:
        from datetime import datetime, timezone
        assets = prepare_assets(installer, version, notes, datetime.now(timezone.utc).isoformat())
        print('Signed release ready:', tag, ', '.join(name for name, _, _ in assets))
        return

    # Require the public branch and tag to identify this exact commit.
    git = ['git', '-c', f'safe.directory={ROOT}']
    def revision(ref):
        return subprocess.check_output(git + ['rev-parse', ref], cwd=ROOT, text=True).strip()
    head = revision('HEAD')
    if revision(tag + '^{}') != head or revision('refs/remotes/origin/main') != head:
        raise SystemExit('Push this commit to main and its release tag before publishing')
    if subprocess.check_output(git + ['status', '--porcelain'], cwd=ROOT, text=True).strip():
        raise SystemExit('Commit tracked changes before publishing')
    env = {**os.environ, 'GCM_INTERACTIVE': 'never', 'GIT_TERMINAL_PROMPT': '0'}
    credential = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
        capture_output=True, text=True, env=env, timeout=30)
    if credential.returncode:
        raise SystemExit('Git credential unavailable; credential data is not printed')
    token = dict(line.split('=', 1) for line in credential.stdout.splitlines() if '=' in line).get('password')
    if not token:
        raise SystemExit('Git credential did not return a token')

    def request(url, method='GET', data=None, content_type='application/json'):
        headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
            'User-Agent': 'MockInterview-release', 'X-GitHub-Api-Version': '2022-11-28'}
        if data is not None: headers['Content-Type'] = content_type
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=600) as response:
            return json.load(response)

    base = f'https://api.github.com/repos/{REPOSITORY}'
    try:
        release = request(base + '/releases/tags/' + tag)
    except urllib.error.HTTPError as exc:
        if exc.code != 404: raise SystemExit(f'Release query failed: HTTP {exc.code}')
        release = request(base + '/releases', 'POST', json.dumps({'tag_name': tag,
            'name': f'MockInterview {version}', 'body': notes, 'draft': True, 'prerelease': False}, ensure_ascii=False).encode())
    assets = prepare_assets(installer, version, notes, release['created_at'])
    existing = {item['name']: item for item in release.get('assets', [])}
    for name, data, content_type in assets:
        if name in existing:
            item = existing[name]
            expected_digest = 'sha256:' + hashlib.sha256(data).hexdigest()
            if item['size'] != len(data) or (item.get('digest') and item['digest'] != expected_digest):
                raise SystemExit(f'Existing release asset differs: {name}; refusing to replace it')
            print('Asset already exists:', name)
            continue
        url = release['upload_url'].split('{', 1)[0] + '?name=' + urllib.parse.quote(name)
        asset = request(url, 'POST', data, content_type)
        print('Uploaded:', asset['name'], asset['size'], flush=True)
    verified = request(base + '/releases/' + str(release['id']))
    names = {item['name'] for item in verified['assets']}
    if not {name for name, _, _ in assets}.issubset(names):
        raise SystemExit('Release assets incomplete; release remains a draft')
    if verified['draft']:
        verified = request(base + '/releases/' + str(release['id']), 'PATCH', json.dumps({'draft': False, 'make_latest': 'true'}).encode())
    print('Release:', verified['html_url'])
    print('Updater manifest:', f'https://github.com/{REPOSITORY}/releases/latest/download/latest.json')

if __name__ == '__main__':
    main()
