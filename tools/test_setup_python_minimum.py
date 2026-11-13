"""Source runtime security minimum; no GPU or downloads."""
import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import setup
from strata_control import private_files

class PythonMinimum(unittest.TestCase):
    def test_python_310_stops_before_setup_side_effects(self):
        error = io.StringIO()
        with mock.patch.object(setup.sys, "version_info", (3, 10, 16)), contextlib.redirect_stderr(error):
            with mock.patch.object(setup, "mac_setup") as mac, \
                    mock.patch.object(private_files, "adopt_user_defaults") as defaults:
                self.assertEqual(setup.main(), 1)
                mac.assert_not_called()
                defaults.assert_not_called()
        self.assertIn("Python 3.11", error.getvalue())
        self.assertIn(".venv", error.getvalue())

    def test_supported_python_reaches_existing_mac_dispatch(self):
        for version in [(3, 11, 0), (3, 12, 15)]:
            with (
                self.subTest(version=version),
                mock.patch.object(setup.sys, "version_info", version),
                mock.patch.object(setup.sys, "platform", "darwin"),
                mock.patch.object(setup, "CONTROL", False),
                mock.patch.object(setup, "mac_setup", return_value=23) as mac,
                mock.patch.object(private_files, "adopt_user_defaults") as defaults,
            ):
                self.assertEqual(setup.main(), 23)
                mac.assert_called_once()
                defaults.assert_called_once()

    def test_pillow_has_no_vulnerable_interpreter_fallback(self):
        pins = [line for line in (ROOT / "requirements.txt").read_text().splitlines() if line.lower().startswith("pillow")]
        self.assertEqual(pins, ["pillow==13.0.0"])

if __name__ == "__main__":
    unittest.main()
