"""Import-time canary: a scanner that imported this module would write EXECUTED.txt and raise."""
from pathlib import Path

Path(__file__).with_name("EXECUTED.txt").write_text("executed")
raise RuntimeError("never imported by the scanner")
