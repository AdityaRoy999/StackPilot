"""A field picker should not incur the wait reserved for navigation/submission."""
import unittest

from app.browser_driver import is_transitioning_or_submit_action


class TransitionClassificationTests(unittest.TestCase):
    def test_custom_station_picker_is_immediate(self):
        self.assertFalse(is_transitioning_or_submit_action(
            {"tag": "div", "text": "From Enter Source Name"},
            label="From Enter Source Name",
        ))

    def test_search_field_and_combobox_are_immediate(self):
        self.assertFalse(is_transitioning_or_submit_action(
            {"tag": "input", "type": "search", "placeholder": "Search destination"},
            label="Search destination",
        ))
        self.assertFalse(is_transitioning_or_submit_action(
            {"tag": "div", "role": "combobox", "text": "Search flights"},
            label="Search flights",
        ))

    def test_search_submit_and_navigation_still_wait_for_outcome(self):
        self.assertTrue(is_transitioning_or_submit_action(
            {"tag": "span", "text": "SEARCH TRAINS"}, label="SEARCH TRAINS",
        ))
        self.assertTrue(is_transitioning_or_submit_action(
            {"tag": "a", "href": "/trains", "text": "Trains"}, label="Trains",
        ))
        self.assertTrue(is_transitioning_or_submit_action(
            {"tag": "button", "type": "submit", "form_id": "search", "text": "Go"}, label="Go",
        ))

    def test_default_button_outside_form_is_an_immediate_ui_control(self):
        self.assertFalse(is_transitioning_or_submit_action(
            {"tag": "button", "type": "submit", "form_id": "", "text": "Theme"}, label="Theme",
        ))
        self.assertFalse(is_transitioning_or_submit_action(
            {"tag": "a", "href": "#menu", "text": "Menu"}, label="Menu",
        ))

    def test_keyword_substrings_do_not_create_a_transition(self):
        self.assertFalse(is_transitioning_or_submit_action(
            {"tag": "div", "text": "Research"}, label="Research",
        ))
