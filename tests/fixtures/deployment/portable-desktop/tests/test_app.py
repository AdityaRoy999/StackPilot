import unittest
from app import increment


class Counter(unittest.TestCase):
    def test_repeated_input_advances_the_counter(self):
        value = 0
        for _ in range(3):value=increment(value)
        self.assertEqual(value,3)
