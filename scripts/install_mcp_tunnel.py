#!/usr/bin/env python3
"""Install the current official OpenAI tunnel client for local development.

Downloads only public release assets and verifies the published SHA-256 digest.
No credentials, tunnels, or external sharing are created by this installer.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.tools' / 'tunnel-client'


def download(url, path):
    if not url.startswith(('https://api.github.com/repos/openai/tunnel-client/',
                           'https://github.com/openai/tunnel-client/')):
        raise RuntimeError('Unexpected release download location')
    subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
                    '--max-time', '120', url, '--output', str(path)], check=True)


def main():
    if platform.system() != 'Darwin' or platform.machine() not in ('arm64', 'x86_64'):
        raise RuntimeError('This installer currently supports macOS arm64 and x86_64.')
    arch = 'arm64' if platform.machine() == 'arm64' else 'amd64'
    with tempfile.TemporaryDirectory(prefix='mochi-tunnel-install-') as directory:
        temporary = Path(directory)
        download('https://api.github.com/repos/openai/tunnel-client/releases/latest', temporary / 'release.json')
        release = json.loads((temporary / 'release.json').read_text())
        name = f'tunnel-client-{release["tag_name"]}-darwin-{arch}.zip'
        assets = {item['name']: item['browser_download_url'] for item in release['assets']}
        download(assets[name], temporary / 'client.zip')
        download(assets['SHA256SUMS.txt'], temporary / 'checksums.txt')
        expected = None
        for line in (temporary / 'checksums.txt').read_text().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].lstrip('*').removeprefix('./') == name:
                expected = parts[0]
        actual = hashlib.sha256((temporary / 'client.zip').read_bytes()).hexdigest()
        if expected is None or actual != expected:
            raise RuntimeError('Official tunnel-client checksum did not match.')
        with zipfile.ZipFile(temporary / 'client.zip') as archive:
            binaries = [item for item in archive.infolist()
                        if not item.is_dir() and Path(item.filename).name == 'tunnel-client']
            if len(binaries) != 1:
                raise RuntimeError('Expected one tunnel-client executable in the official archive.')
            DEST.parent.mkdir(parents=True, exist_ok=True)
            staged = DEST.with_suffix('.installing')
            with archive.open(binaries[0]) as source, staged.open('wb') as target:
                shutil.copyfileobj(source, target)
            staged.chmod(0o700)
            os.replace(staged, DEST)
        print(f'Installed official tunnel-client {release["tag_name"]}: {DEST}')
        print('SHA-256 verified. No tunnel or sharing was started.')


if __name__ == '__main__':
    main()
