"""Pure timer/read classifier tests. No process, container, native or model."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch
p=Path(__file__).resolve().parents[1]/'native/c72-native-supervisor.py'
spec=importlib.util.spec_from_file_location('sanity_supervisor',p)
supervisor=importlib.util.module_from_spec(spec);spec.loader.exec_module(supervisor)
class SanityPolicy(unittest.TestCase):
 def test_defaults(self):
  self.assertEqual(supervisor.sanity_timing(),dict(startupOverallTimeoutMs=120000,noProgressTimeoutMs=60000,inspectionTimeoutMs=15000,cleanupTimeoutMs=60000))
 def test_closed_finite_policy(self):
  for value in [{}, {'unexpected':1}, {**supervisor.sanity_timing(),'inspectionTimeoutMs':True},{**supervisor.sanity_timing(),'cleanupTimeoutMs':120001}]:
   with self.assertRaises(RuntimeError):supervisor.sanity_timing(value)
 def test_classified_transient_reads_only(self):
  for error in [subprocess.TimeoutExpired('SYNTHETIC',15),subprocess.CalledProcessError(1,'SYNTHETIC')]:
   with patch.object(supervisor.subprocess,'run',side_effect=error):
    with self.assertRaises(supervisor.GuiReadUnavailable):supervisor.probe_native_gui(12,{},15,9)
 def test_real_identity_change_denies_immediately(self):
  for raw in [b'{"pid":13,"viewable":true,"startTicks":9}',b'{"pid":12,"viewable":true,"startTicks":10}',b'{"pid":12,"viewable":false,"startTicks":9}',b'{"pid":12,"viewable":true,"startTicks":true}']:
   with patch.object(supervisor.subprocess,'run',return_value=SimpleNamespace(stdout=raw)):
    with self.assertRaises(RuntimeError) as result:supervisor.probe_native_gui(12,{},15,9)
    self.assertNotIsInstance(result.exception,supervisor.GuiReadUnavailable)
 def test_loaded_success_keeps_original_identity(self):
  with patch.object(supervisor.subprocess,'run',return_value=SimpleNamespace(stdout=b'{"pid":12,"viewable":true,"startTicks":9}')) as run:
   self.assertEqual(supervisor.probe_native_gui(12,{},15,9)['startTicks'],9)
   self.assertEqual(run.call_args.kwargs['timeout'],15)
 def test_progress_not_one_transient_read_controls_retry_budget(self):
  timing=supervisor.sanity_timing()
  self.assertEqual(supervisor.gui_read_budget(timing,5,0,120,120,1),15)
  self.assertEqual(supervisor.gui_read_budget(timing,59,0,120,120,1),1)
  with self.assertRaises(RuntimeError):supervisor.gui_read_budget(timing,60,0,120,120,1)
 def test_startup_and_actual_expiry_clip_the_read(self):
  timing=supervisor.sanity_timing()
  self.assertEqual(supervisor.gui_read_budget(timing,5,0,6,120,0),1)
  self.assertEqual(supervisor.gui_read_budget(timing,5,0,120,7,1),2)
  with self.assertRaises(RuntimeError):supervisor.gui_read_budget(timing,7,0,120,7,1)
if __name__=='__main__':unittest.main()
