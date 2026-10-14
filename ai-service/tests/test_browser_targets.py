import unittest

from app.browser_testing.targets import remember_targets, resolve_target_reference


class FakeSession:
    def __init__(self, elements):
        self.current_url = 'https://fixture.invalid/search'
        self.target_id = 'tab-A'
        self._navigation_generation = 1
        self._selected_frame = None
        self.interactive_elements = elements
        self.replacement = elements
        self.connected = True

    async def evaluate(self, expression):
        return self.connected

    async def extract_interactive_tree(self):
        self.interactive_elements = self.replacement
        remember_targets(self)
        return {'elements': self.interactive_elements}


class TargetResolutionTests(unittest.IsolatedAsyncioTestCase):
    def original(self):
        return {'id': 4, 'tag': 'button', 'role': 'button', 'text': 'Search trains',
                'form_id': 'trains', 'card_context': 'Train search'}

    async def test_connected_reference_is_kept(self):
        session = FakeSession([self.original()])
        remember_targets(session)
        self.assertEqual((await resolve_target_reference(session, 4))['element_id'], 4)

    async def test_rerender_rebinds_unique_same_page_target(self):
        session = FakeSession([self.original()])
        remember_targets(session)
        session.connected = False
        session.replacement = [{**self.original(), 'id': 9}]
        result = await resolve_target_reference(session, 4)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['element_id'], 9)
        self.assertTrue(result['rebound'])

    async def test_duplicate_control_is_never_guessed(self):
        session = FakeSession([self.original()])
        remember_targets(session)
        session.connected = False
        session.replacement = [{**self.original(), 'id': 9}, {**self.original(), 'id': 10}]
        result = await resolve_target_reference(session, 4)
        self.assertEqual(result['status'], 'stale_element')
        self.assertEqual(result['candidate_count'], 2)

    async def test_navigation_or_frame_change_invalidates_old_reference(self):
        for changed in ('route', 'frame', 'tab'):
            session = FakeSession([self.original()])
            remember_targets(session)
            session.connected = False
            if changed == 'route':
                session.current_url = 'https://fixture.invalid/checkout'
            else:
                if changed == 'frame':
                    session._selected_frame = 'other'
                else:
                    session.target_id = 'tab-B'
            result = await resolve_target_reference(session, 4)
            self.assertEqual(result['status'], 'stale_element')

    async def test_unknown_reference_is_not_matched_by_text(self):
        session = FakeSession([self.original()])
        remember_targets(session)
        result = await resolve_target_reference(session, 77)
        self.assertEqual(result['status'], 'stale_element')
