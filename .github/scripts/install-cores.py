#!/usr/bin/env python3
"""Install pinned Linux AMD64 validation cores after verifying archive SHA-256."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import socket
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request


MANIFEST = Path(__file__).with_name('toolchain.json')
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_BINARY = 256 * 1024 * 1024


class InstallError(RuntimeError):
    """Installer failures with messages safe for public workflow logs."""


def select_tools(value, available):
    names = re.split(r'[\s,]+', value.strip())
    if names in (['both'], ['all']):
        names = list(available)
    if not names or not names[0] or any(name not in available for name in names):
        raise InstallError('Select sing-box, mihomo, or both validation cores.')
    return list(dict.fromkeys(names))


def download(url, *, attempts=3, timeout=30, total_timeout=120):
    """Retry transient transport/HTTP failures within a bounded download budget."""
    if not url.startswith('https://'):
        raise InstallError('Core downloads require HTTPS.')
    deadline = time.monotonic() + total_timeout
    for attempt in range(attempts):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise InstallError('Core download exceeded its time limit.')
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'HotKids-Rules-core-installer'})
            with urllib.request.urlopen(request, timeout=min(timeout, remaining)) as response:
                chunks, count = [], 0
                while True:
                    if time.monotonic() >= deadline:
                        raise TimeoutError()
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > MAX_ARCHIVE:
                        raise InstallError('Core archive exceeds the size limit.')
                    chunks.append(chunk)
                if not count:
                    raise InstallError('Core download returned an empty archive.')
                return b''.join(chunks)
        except urllib.error.HTTPError as error:
            transient = error.code in {408, 429} or 500 <= error.code < 600
            message = f'Core download failed (HTTP {error.code}).'
            error.close()
        except (OSError, urllib.error.URLError, TimeoutError, socket.timeout):
            transient, message = True, 'Core download failed (network error).'
        if not transient or attempt + 1 == attempts:
            raise InstallError(message) from None
        delay = min(2 ** attempt, max(0, deadline - time.monotonic()))
        if delay:
            time.sleep(delay)
    raise InstallError('Core download failed.')


def binary_from_archive(archive, spec):
    """Read only the expected regular file; never extract archive paths to disk."""
    digest = spec.get('sha256', '')
    if not re.fullmatch(r'[0-9a-f]{64}', digest) or hashlib.sha256(archive).hexdigest() != digest:
        raise InstallError('Core archive SHA-256 verification failed.')
    try:
        if spec.get('format') == 'tar.gz':
            with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
                members = [item for item in package.getmembers() if item.name == spec.get('member')]
                if len(members) != 1 or not members[0].isfile() or members[0].size > MAX_BINARY:
                    raise InstallError('Core archive is missing its expected regular executable.')
                with package.extractfile(members[0]) as source:
                    binary = source.read(MAX_BINARY + 1)
                if len(binary) != members[0].size:
                    raise InstallError('Core executable is truncated.')
        elif spec.get('format') == 'gz':
            with gzip.GzipFile(fileobj=io.BytesIO(archive)) as source:
                binary = source.read(MAX_BINARY + 1)
        else:
            raise InstallError('Unsupported core archive format.')
    except (OSError, EOFError, tarfile.TarError):
        raise InstallError('Core archive is invalid or truncated.') from None
    if not binary or len(binary) > MAX_BINARY:
        raise InstallError('Core executable is empty or exceeds the size limit.')
    return binary


def install(names, destination, manifest):
    """Verify every selected tool before replacing any installed executables."""
    if manifest.get('platform') != 'linux-amd64':
        raise InstallError('The validation toolchain must target linux-amd64.')
    specs = manifest.get('tools')
    if not isinstance(specs, dict) or any(name not in specs for name in names):
        raise InstallError('The validation toolchain manifest is incomplete.')
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='core-install-', dir=destination.parent) as folder:
        staging = Path(folder)
        for name in names:
            spec = specs[name]
            if not isinstance(spec, dict):
                raise InstallError('Invalid validation toolchain entry.')
            archive = download(spec.get('url', ''))
            target = staging / name
            target.write_bytes(binary_from_archive(archive, spec))
            target.chmod(0o755)
        destination.mkdir(parents=True, exist_ok=True)
        for name in names:
            os.replace(staging / name, destination / name)
            print(f'{name} {specs[name]["version"]}: installed after SHA-256 verification.')
    return {name: destination / name for name in names}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tools', default='both')
    parser.add_argument('--destination', type=Path,
                        default=Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir())) / 'hotkids-core-tools')
    args = parser.parse_args(argv)
    try:
        if platform.system() != 'Linux' or platform.machine().lower() not in {'x86_64', 'amd64'}:
            raise InstallError('Validation cores currently support Linux AMD64 runners only.')
        manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
        names = select_tools(args.tools, manifest.get('tools', {}))
        installed = install(names, args.destination, manifest)
        if path_file := os.environ.get('GITHUB_PATH'):
            with open(path_file, 'a', encoding='utf-8') as output:
                output.write(str(args.destination.resolve()) + '\n')
        if output_file := os.environ.get('GITHUB_OUTPUT'):
            with open(output_file, 'a', encoding='utf-8') as output:
                output.write('bin-dir=' + str(args.destination.resolve()) + '\n')
                for name in ('sing-box', 'mihomo'):
                    output.write(name + '-path=' + str(installed.get(name, '')) + '\n')
    except (InstallError, OSError, ValueError, TypeError, KeyError) as error:
        message = str(error) if isinstance(error, InstallError) else 'Cannot load or install the pinned validation toolchain.'
        print(message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
