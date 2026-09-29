"""Shim: python tools/stagecut/cut_tidegate.py == python tools/stagecut/cut_stage.py tidegate."""
import runpy, sys; from pathlib import Path; sys.argv = [sys.argv[0], "tidegate"]; runpy.run_path(str(Path(__file__).with_name("cut_stage.py")), run_name="__main__")
