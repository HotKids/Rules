"""Validation binaries are pinned, verified and never installed from partial downloads."""
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
SPEC = importlib.util.spec_from_file_location('install_cores', SCRIPTS / 'install-cores.py')
cores = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cores)


def gzip_spec(binary=b'verified executable'):
    archive = gzip.compress(binary)
    return archive, {'version': 'test', 'url': 'https://example.invalid/core.gz',
                     'sha256': hashlib.sha256(archive).hexdigest(), 'format': 'gz'}


def tar_archive(member='package/sing-box', binary=b'verified executable', symlink=False):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as package:
        info = tarfile.TarInfo(member)
        if symlink:
            info.type, info.linkname = tarfile.SYMTYPE, '../../outside'
            package.addfile(info)
        else:
            info.size = len(binary)
            package.addfile(info, io.BytesIO(binary))
        # Unrelated members are never extracted, including path traversal attempts.
        other = tarfile.TarInfo('../../outside')
        other.size = 7
        package.addfile(other, io.BytesIO(b'outside'))
    archive = buffer.getvalue()
    return archive, {'version': 'test', 'url': 'https://example.invalid/core.tar.gz',
                     'sha256': hashlib.sha256(archive).hexdigest(), 'format': 'tar.gz', 'member': member}


class CoreToolchainTests(unittest.TestCase):
    def test_corrupt_sha_or_truncated_archive_cannot_replace_an_existing_tool(self):
        archive, spec = gzip_spec()
        invalid = dict(spec, sha256='0' * 64)
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'bin'
            destination.mkdir()
            target = destination / 'mihomo'
            target.write_bytes(b'existing verified tool')
            with patch.object(cores, 'download', return_value=archive), self.assertRaisesRegex(cores.InstallError, 'SHA-256'):
                cores.install(['mihomo'], destination, {'platform': 'linux-amd64', 'tools': {'mihomo': invalid}})
            self.assertEqual(target.read_bytes(), b'existing verified tool')
        truncated = archive[:-6]
        with self.assertRaisesRegex(cores.InstallError, 'invalid or truncated'):
            cores.binary_from_archive(truncated, dict(spec, sha256=hashlib.sha256(truncated).hexdigest()))

    def test_tar_installs_only_the_expected_regular_file_without_extracting_paths(self):
        archive, spec = tar_archive()
        with tempfile.TemporaryDirectory() as folder, patch.object(cores, 'download', return_value=archive), \
                contextlib.redirect_stdout(io.StringIO()):
            destination = Path(folder) / 'bin'
            installed = cores.install(['sing-box'], destination, {'platform': 'linux-amd64', 'tools': {'sing-box': spec}})
            self.assertEqual(installed['sing-box'].read_bytes(), b'verified executable')
            self.assertTrue(installed['sing-box'].stat().st_mode & 0o111)
            self.assertEqual(sorted(item.name for item in Path(folder).iterdir()), ['bin'])
            self.assertEqual(sorted(item.name for item in destination.iterdir()), ['sing-box'])
        linked, linked_spec = tar_archive(symlink=True)
        with self.assertRaisesRegex(cores.InstallError, 'regular executable'):
            cores.binary_from_archive(linked, linked_spec)

    def test_all_selected_archives_are_verified_before_any_tool_is_replaced(self):
        first, first_spec = tar_archive()
        second, second_spec = gzip_spec()
        second_spec['sha256'] = '0' * 64
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'bin'
            destination.mkdir()
            (destination / 'sing-box').write_bytes(b'old sing-box')
            (destination / 'mihomo').write_bytes(b'old mihomo')
            with patch.object(cores, 'download', side_effect=[first, second]), self.assertRaises(cores.InstallError):
                cores.install(['sing-box', 'mihomo'], destination, {'platform': 'linux-amd64',
                    'tools': {'sing-box': first_spec, 'mihomo': second_spec}})
            self.assertEqual((destination / 'sing-box').read_bytes(), b'old sing-box')
            self.assertEqual((destination / 'mihomo').read_bytes(), b'old mihomo')

    def test_download_retries_transient_errors_but_not_missing_releases(self):
        failures = [urllib.error.HTTPError('https://example.invalid', code, 'temporary', {}, None)
                    for code in (503, 429)]
        with patch.object(cores.urllib.request, 'urlopen', side_effect=[*failures, io.BytesIO(b'archive')]) as request, \
                patch.object(cores.time, 'sleep') as sleep:
            self.assertEqual(cores.download('https://example.invalid/core'), b'archive')
            self.assertEqual(request.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])
            self.assertTrue(all(call.kwargs['timeout'] <= 30 for call in request.call_args_list))
        missing = urllib.error.HTTPError('https://example.invalid', 404, 'missing', {}, None)
        with patch.object(cores.urllib.request, 'urlopen', side_effect=missing) as request, \
                patch.object(cores.time, 'sleep') as sleep, self.assertRaisesRegex(cores.InstallError, 'HTTP 404'):
            cores.download('https://example.invalid/core')
        self.assertEqual(request.call_count, 1)
        sleep.assert_not_called()

    def test_empty_or_excessive_download_and_time_budget_fail_closed(self):
        with patch.object(cores.urllib.request, 'urlopen', return_value=io.BytesIO()), \
                self.assertRaisesRegex(cores.InstallError, 'empty archive'):
            cores.download('https://example.invalid/core')
        with patch.object(cores.urllib.request, 'urlopen', return_value=io.BytesIO(b'12345')), \
                patch.object(cores, 'MAX_ARCHIVE', 4), self.assertRaisesRegex(cores.InstallError, 'size limit'):
            cores.download('https://example.invalid/core')
        with patch.object(cores.time, 'monotonic', side_effect=[0, 121]), \
                patch.object(cores.urllib.request, 'urlopen') as request, \
                self.assertRaisesRegex(cores.InstallError, 'time limit'):
            cores.download('https://example.invalid/core')
        request.assert_not_called()

    def test_action_environment_is_written_only_after_verified_installation(self):
        archive, spec = gzip_spec()
        manifest = {'platform': 'linux-amd64', 'tools': {'mihomo': spec}}
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            path_file, output_file = folder / 'path', folder / 'output'
            manifest_file = folder / 'manifest.json'
            manifest_file.write_text(json.dumps(manifest))
            with patch.object(cores, 'MANIFEST', manifest_file), \
                    patch.object(cores.platform, 'system', return_value='Linux'), \
                    patch.object(cores.platform, 'machine', return_value='x86_64'), \
                    patch.object(cores, 'download', return_value=archive), \
                    patch.dict(os.environ, {'GITHUB_PATH': str(path_file), 'GITHUB_OUTPUT': str(output_file)}), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cores.main(['--tools', 'mihomo', '--destination', str(folder / 'bin')]), 0)
            self.assertEqual(path_file.read_text(), str(folder / 'bin') + '\n')
            self.assertIn('mihomo-path=' + str(folder / 'bin' / 'mihomo'), output_file.read_text())
            self.assertIn('sing-box-path=\n', output_file.read_text())
            path_file.unlink()
            output_file.unlink()
            manifest['tools']['mihomo']['sha256'] = '0' * 64
            manifest_file.write_text(json.dumps(manifest))
            with patch.object(cores, 'MANIFEST', manifest_file), \
                    patch.object(cores.platform, 'system', return_value='Linux'), \
                    patch.object(cores.platform, 'machine', return_value='x86_64'), \
                    patch.object(cores, 'download', return_value=archive), \
                    patch.dict(os.environ, {'GITHUB_PATH': str(path_file), 'GITHUB_OUTPUT': str(output_file)}), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cores.main(['--tools', 'mihomo', '--destination', str(folder / 'bin')]), 1)
            self.assertFalse(path_file.exists())
            self.assertFalse(output_file.exists())
        self.assertEqual(cores.select_tools('sing-box mihomo', {'sing-box': {}, 'mihomo': {}}), ['sing-box', 'mihomo'])
        with self.assertRaises(cores.InstallError):
            cores.select_tools('mihomo; echo unsafe', {'mihomo': {}})


if __name__ == '__main__':
    unittest.main()
