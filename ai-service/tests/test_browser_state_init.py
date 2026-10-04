import importlib.util
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest

from app.browser_testing.run_state import RunJournal, owner_key


script = Path(__file__).resolve().parents[1] / 'init_browser_state.py'
spec = importlib.util.spec_from_file_location('init_browser_state', script)
initializer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(initializer)


@unittest.skipUnless(hasattr(os, 'chown'), 'Linux volume ownership qualification')
class BrowserStateInitializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.legacy = self.root / 'legacy'
        self.state = self.root / 'state'

    def initialize(self):
        return initializer.initialize(self.state, self.legacy, os.getuid(), os.getgid())

    def test_new_volume_is_private_and_service_can_write(self):
        result = self.initialize()
        self.assertFalse(result['migrated'])
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)
        journal = RunJournal(self.state / initializer.DATABASE)
        run = journal.start(owner_key('owner', 'session'), 'Inspect website')
        self.assertEqual(journal.state(run)['state'], 'observing')

    def test_migration_preserves_uncertain_actions_and_owner_boundary(self):
        journal = RunJournal(self.legacy / initializer.DATABASE)
        owner = owner_key('owner', 'session')
        run = journal.start(owner, 'Inspect website')
        journal.record(run, {'type': 'tool_call', 'name': 'browser_interact', 'id': 'pending', 'arguments': {'action': 'click'}})
        journal.record(run, {'type': 'interrupted'})
        self.assertTrue(self.initialize()['migrated'])
        copied = RunJournal(self.state / initializer.DATABASE)
        self.assertEqual(copied.previous(owner)['id'], run)
        self.assertIsNone(copied.previous(owner_key('other', 'session')))
        self.assertEqual(stat.S_IMODE((self.state / initializer.DATABASE).stat().st_mode), 0o600)
        self.assertEqual(journal.previous(owner)['id'], run)

    def test_sqlite_backup_includes_committed_wal_transactions(self):
        self.legacy.mkdir()
        source = sqlite3.connect(self.legacy / initializer.DATABASE)
        self.addCleanup(source.close)
        source.execute('PRAGMA journal_mode=WAL')
        source.execute('PRAGMA wal_autocheckpoint=0')
        source.execute('CREATE TABLE evidence (value TEXT)')
        source.execute("INSERT INTO evidence VALUES ('retained')")
        source.commit()
        self.assertTrue((self.legacy / (initializer.DATABASE + '-wal')).exists())
        self.initialize()
        with sqlite3.connect(self.state / initializer.DATABASE) as copied:
            self.assertEqual(copied.execute('SELECT value FROM evidence').fetchone()[0], 'retained')

    def test_existing_volume_wins_and_repeated_initialization_preserves_it(self):
        self.state.mkdir()
        journal = RunJournal(self.state / initializer.DATABASE)
        owner = owner_key('owner', 'session')
        run = journal.start(owner, 'Current volume state')
        self.legacy.mkdir()
        (self.legacy / initializer.DATABASE).write_bytes(b'legacy must not overwrite current data')
        for _ in range(2):
            self.assertFalse(self.initialize()['migrated'])
            self.assertEqual(journal.previous(owner)['id'], run)

    def test_corrupt_legacy_data_cannot_publish_a_partial_journal(self):
        self.legacy.mkdir()
        (self.legacy / initializer.DATABASE).write_bytes(b'invalid sqlite')
        with self.assertRaises(sqlite3.DatabaseError):
            self.initialize()
        self.assertFalse((self.state / initializer.DATABASE).exists())
        self.assertEqual(list(self.state.iterdir()), [])

    def test_symlinks_are_rejected_without_changing_external_permissions(self):
        outside = self.root / 'outside'
        outside.write_text('retained')
        outside.chmod(0o640)
        for name in (initializer.DATABASE, initializer.DATABASE + '-wal'):
            with self.subTest(name=name):
                self.state.mkdir(exist_ok=True)
                link = self.state / name
                link.symlink_to(outside)
                with self.assertRaises(ValueError):
                    self.initialize()
                self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o640)
                link.unlink()
