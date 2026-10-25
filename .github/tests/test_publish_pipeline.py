"""Exercise safe publication against real local Git remotes and competing writers."""
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest

import yaml


PUBLISH = Path(__file__).resolve().parents[1] / 'scripts' / 'publish-generated.py'
OUTPUT = 'Surge/Module/BlockAds.sgmodule'


class PublishPipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.remote = self.root / 'remote.git'
        self.local = self.root / 'local'
        self.writer = self.root / 'writer'
        self.state = self.root / 'state.json'
        self.git(self.root, 'init', '--bare', '--initial-branch=master', str(self.remote))
        self.git(self.root, 'clone', str(self.remote), str(self.local))
        self.write(self.local, OUTPUT, 'old output\n')
        self.write(self.local, 'Surge/Profile.conf', 'original input\n')
        self.write(self.local, 'README.md', 'original readme\n')
        self.commit(self.local, 'initial')
        self.git(self.local, 'push', 'origin', 'master')
        self.git(self.root, 'clone', str(self.remote), str(self.writer))

    def git(self, cwd, *args):
        return subprocess.check_output(
            ['git', *args], cwd=cwd, stderr=subprocess.PIPE, text=True,
            env={**os.environ, 'GIT_AUTHOR_NAME': 'test', 'GIT_COMMITTER_NAME': 'test',
                 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
                 'GIT_COMMITTER_EMAIL': 'test@example.invalid'},
        ).strip()

    def write(self, repo, path, text):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding='utf-8')

    def commit(self, repo, message):
        self.git(repo, 'add', '-A')
        self.git(repo, 'commit', '-m', message)

    def run_helper(self, *args):
        return subprocess.run([sys.executable, str(PUBLISH), *args], cwd=self.local,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=getattr(self, 'helper_env', None))

    def capture(self):
        result = self.run_helper('capture', '--kind', 'modules-formal', '--state', str(self.state))
        self.assertEqual(result.returncode, 0, result.stderr)

    def publish(self):
        return self.run_helper('publish', '--state', str(self.state), '--message', 'generated')

    def remote_text(self, path):
        return self.git(self.root, '--git-dir', str(self.remote), 'show', f'master:{path}')

    def test_unrelated_commit_is_preserved_while_output_is_published(self):
        self.capture()
        self.write(self.local, OUTPUT, 'new output\n')
        self.write(self.writer, 'README.md', 'new readme\n')
        self.commit(self.writer, 'documentation')
        self.git(self.writer, 'push')
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_text(OUTPUT), 'new output')
        self.assertEqual(self.remote_text('README.md'), 'new readme')

    def test_changed_input_blocks_stale_output(self):
        self.capture()
        self.write(self.local, OUTPUT, 'stale output\n')
        self.write(self.writer, 'Surge/Profile.conf', 'new input\n')
        self.commit(self.writer, 'change source')
        self.git(self.writer, 'push')
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('inputs or outputs changed', result.stderr)
        self.assertEqual(self.remote_text(OUTPUT), 'old output')
        self.assertEqual(self.remote_text('Surge/Profile.conf'), 'new input')

    def test_competing_output_edit_is_preserved(self):
        self.capture()
        self.write(self.local, OUTPUT, 'stale output\n')
        self.write(self.writer, OUTPUT, 'manual edit\n')
        self.commit(self.writer, 'manual output')
        self.git(self.writer, 'push')
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.remote_text(OUTPUT), 'manual edit')

    def test_out_of_scope_generation_cannot_be_committed(self):
        self.capture()
        self.write(self.local, OUTPUT, 'new output\n')
        self.write(self.local, 'Surge/Profile.conf', 'accidental source edit\n')
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('outside its publication scope', result.stderr)
        self.assertEqual(self.remote_text(OUTPUT), 'old output')

    def test_rename_into_output_cannot_hide_source_deletion(self):
        result = self.run_helper('capture', '--kind', 'config', '--state', str(self.state))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.git(self.local, 'mv', 'Surge/Profile.conf', 'Surge/Module/Profile.sgmodule')
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('outside its publication scope', result.stderr)
        self.assertEqual(self.remote_text('Surge/Profile.conf'), 'original input')

    def test_no_changes_does_not_create_commit(self):
        initial = self.git(self.local, 'rev-parse', 'HEAD')
        self.capture()
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), initial)

    def test_push_retries_are_bounded(self):
        self.capture()
        self.write(self.local, OUTPUT, 'new output\n')
        hook = self.remote / 'hooks' / 'pre-receive'
        counter = self.remote / 'attempts'
        hook.write_text('#!/bin/sh\nprintf "attempt\\n" >> "' + str(counter) + '"\nexit 1\n')
        hook.chmod(0o755)
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('bounded retries', result.stderr)
        self.assertEqual(counter.read_text().splitlines(), ['attempt'] * 3)
        self.assertEqual(self.remote_text(OUTPUT), 'old output')

    def test_history_rewrite_is_rejected(self):
        self.write(self.writer, 'README.md', 'later readme\n')
        self.commit(self.writer, 'later')
        self.git(self.writer, 'push')
        self.git(self.local, 'pull', '--ff-only')
        self.capture()
        self.write(self.local, OUTPUT, 'new output\n')
        self.git(self.writer, 'reset', '--hard', 'HEAD~1')
        self.write(self.writer, 'README.md', 'rewritten readme\n')
        self.commit(self.writer, 'rewrite')
        self.git(self.writer, 'push', '--force')
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('history changed', result.stderr)
        self.assertEqual(self.remote_text('README.md'), 'rewritten readme')
        self.assertEqual(self.remote_text(OUTPUT), 'old output')

    def test_remote_rewind_is_rejected_even_when_push_would_be_fast_forward(self):
        self.write(self.writer, 'README.md', 'later readme\n')
        self.commit(self.writer, 'later')
        self.git(self.writer, 'push')
        self.git(self.local, 'pull', '--ff-only')
        self.capture()
        self.write(self.local, OUTPUT, 'new output\n')
        self.git(self.writer, 'reset', '--hard', 'HEAD~1')
        self.git(self.writer, 'push', '--force')
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('history changed', result.stderr)
        self.assertEqual(self.remote_text(OUTPUT), 'old output')

    def test_input_advance_between_fetch_and_push_is_rejected_by_lease(self):
        self.capture()
        self.write(self.local, OUTPUT, 'stale output\n')
        real_git = shutil.which('git')
        wrapper_dir = self.root / 'bin'
        wrapper_dir.mkdir()
        wrapper = wrapper_dir / 'git'
        marker = self.root / 'raced'
        wrapper.write_text(f'''#!{sys.executable}
import os, pathlib, subprocess, sys
real_git = {real_git!r}
writer = {str(self.writer)!r}
marker = pathlib.Path({str(marker)!r})
if sys.argv[1] == 'push' and not marker.exists():
    marker.touch()
    target = pathlib.Path(writer) / 'Surge/Profile.conf'
    target.write_text('racing input\\n')
    env = dict(os.environ, GIT_AUTHOR_NAME='test', GIT_COMMITTER_NAME='test',
               GIT_AUTHOR_EMAIL='test@example.invalid', GIT_COMMITTER_EMAIL='test@example.invalid')
    for args in [('add', '-A'), ('commit', '-m', 'race'), ('push',)]:
        subprocess.run([real_git, '-C', writer, *args], env=env, check=True, capture_output=True)
os.execv(real_git, [real_git, *sys.argv[1:]])
''')
        wrapper.chmod(0o755)
        self.helper_env = {**os.environ, 'PATH': str(wrapper_dir) + os.pathsep + os.environ['PATH']}
        result = self.publish()
        self.assertTrue(marker.exists())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('inputs or outputs changed', result.stderr)
        self.assertEqual(self.remote_text('Surge/Profile.conf'), 'racing input')
        self.assertEqual(self.remote_text(OUTPUT), 'old output')

    def test_whale_preserves_completed_prefix_and_rewrites_only_new_commits(self):
        workflow = PUBLISH.parents[1] / 'workflows' / 'whale.yml'
        steps = yaml.safe_load(workflow.read_text(encoding='utf-8'))['jobs']['whale']['steps']
        identify = next(step['run'] for step in steps if step.get('id') == 'history')
        rewrite = next(step['run'] for step in steps if step.get('name') == 'Rewrite remaining commit messages')
        output = self.root / 'history-output'

        def rewrite_history():
            output.write_text('')
            env = {**os.environ, 'BRANCH': 'master', 'GITHUB_OUTPUT': str(output),
                   'FILTER_BRANCH_SQUELCH_WARNING': '1'}
            subprocess.run(['bash', '-euo', 'pipefail', '-c', identify], cwd=self.local,
                           env=env, check=True, capture_output=True, timeout=30)
            values = dict(line.split('=', 1) for line in output.read_text().splitlines())
            env.update(ORIGINAL_SHA=values['original'], BOUNDARY_SHA=values['boundary'])
            subprocess.run(['bash', '-euo', 'pipefail', '-c', rewrite], cwd=self.local,
                           env=env, check=True, capture_output=True, timeout=30)
            return values

        self.assertEqual(rewrite_history()['boundary'], '')
        completed = self.git(self.local, 'rev-parse', 'HEAD')
        self.write(self.local, 'README.md', 'new change after cleanup\n')
        self.commit(self.local, 'a new message')
        self.assertEqual(rewrite_history()['boundary'], completed)
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD^'), completed)
        self.assertEqual(self.git(self.local, 'log', '--format=%s').splitlines(), ['🐳', '🐳'])


if __name__ == '__main__':
    unittest.main()
