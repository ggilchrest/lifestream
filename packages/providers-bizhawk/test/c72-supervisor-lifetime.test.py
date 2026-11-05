"""Pure supervisor source tests. No process, container, native input or model."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'native/c72-native-supervisor.py'
spec = importlib.util.spec_from_file_location('ct63_supervisor_source', source)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class OriginalNativeLifetime(unittest.TestCase):
    def fixture(self):
        now = 1800000000
        expires = (now + 120) * 1000
        authority = {'schemaVersion': 'ct-native-authority-lifetime/1',
                     'expiresAt': '2027-01-15T08:02:00.000Z', 'remainingMs': 120000}
        # Derive the ISO from the fixed wall clock so fixture identity is exact.
        from datetime import datetime, timezone
        authority['expiresAt'] = datetime.fromtimestamp(expires / 1000, timezone.utc).isoformat()
        prepared = {'expiresAtMs': expires, 'sessionDurationMs': 90000,
                    'scopeDigest': hashlib.sha256(b'{}').hexdigest(),
                    'pinsDigest': 'a' * 64, 'romSha1': 'b' * 40}
        options = {'scope': {}, 'scopeDigest': prepared['scopeDigest'],
                   'protocol': 'lifestream-game-control/1', 'pinsDigest': 'a' * 64,
                   'romSha1': 'b' * 40, 'port': 12345, 'sessionDurationMs': 90000,
                   'frameDirectory': '/TEST/no-native/frames'}
        def bridge(value):
            return {'phase': 'launch', 'environment': {
                'LIFESTREAM_BIZHAWK_PAIRING_SECRET': base64.b64encode(bytes(32)).decode(),
                'LIFESTREAM_BIZHAWK_OPTIONS': json.dumps(value),
                'LIFESTREAM_BIZHAWK_EVIDENCE_FILE': '/TEST/no-native/evidence/native-evidence.json'}}
        return now, prepared, authority, options, bridge

    def test_only_new_mode_removes_child_start_gameplay_clock(self):
        now, prepared, authority, _, _ = self.fixture()
        self.assertFalse(supervisor.native_lifetime_current(prepared, 10, 105, now + 95, 130))
        prepared['nativeAuthority'] = authority
        self.assertTrue(supervisor.native_lifetime_current(prepared, 10, 105, now + 95, 130))
        self.assertFalse(supervisor.native_lifetime_current(prepared, 10, 130, now + 95, 130))
        self.assertFalse(supervisor.native_lifetime_current(prepared, 10, 105, now + 120, 130))

    def test_fresh_five_minute_authority_never_restamps_existing_deadline(self):
        now, prepared, authority, _, _ = self.fixture()
        from datetime import datetime, timezone
        expiry = (now + 300) * 1000
        value = dict(authority, expiresAt=datetime.fromtimestamp(expiry / 1000, timezone.utc).isoformat(), remainingMs=300000)
        self.assertEqual(supervisor.authority_lifetime(value, expiry, now * 1000), value)
        for changed in [dict(value, remainingMs=300001), dict(value, remainingMs=True)]:
            with self.assertRaises(RuntimeError):
                supervisor.authority_lifetime(changed, expiry, now * 1000)
        with self.assertRaises(RuntimeError):
            supervisor.authority_lifetime(value, prepared['expiresAtMs'], now * 1000)
        with self.assertRaises(RuntimeError):
            supervisor.authority_lifetime(value, expiry, expiry)

    def test_real_bridge_requires_same_original_deadline_and_nonincreasing_custody(self):
        now, prepared, authority, options, bridge = self.fixture()
        with patch.object(supervisor.time, 'time', return_value=now):
            supervisor.validate_bridge(bridge(options), Path('/TEST/no-native'), prepared)
            options['nativeAuthority'] = authority
            with self.assertRaises(RuntimeError):
                supervisor.validate_bridge(bridge(options), Path('/TEST/no-native'), prepared)
            prepared['nativeAuthority'] = authority
            supervisor.validate_bridge(bridge(options), Path('/TEST/no-native'), prepared)
            for changed in [dict(authority, remainingMs=120001),
                            dict(authority, extra=True),
                            dict(authority, expiresAt='2030-01-01T00:00:00Z')]:
                options['nativeAuthority'] = changed
                with self.assertRaises(RuntimeError):
                    supervisor.validate_bridge(bridge(options), Path('/TEST/no-native'), prepared)
            prepared['nativeAuthority'] = dict(authority, remainingMs=100000)
            options['nativeAuthority'] = authority
            with self.assertRaises(RuntimeError):
                supervisor.validate_bridge(bridge(options), Path('/TEST/no-native'), prepared)


if __name__ == '__main__':
    unittest.main()
