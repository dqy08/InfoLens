"""extension_usage_report 计数键。"""
import unittest
from unittest.mock import patch

from backend.api.extension_usage import extension_usage_report


class ExtensionUsageTest(unittest.TestCase):
    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_ok_local_cached(self, bump, _log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'ok',
            'segments': 8,
            'segments_ok': 7,
            'cached': 5,
            'version': '0.1.1',
        })
        self.assertEqual(out, {'success': True})
        kinds = [c.args[0] for c in bump.call_args_list]
        self.assertEqual(
            kinds,
            [
                'info_highlight_run',
                'info_highlight_run__local',
                'info_highlight_run__cached',
            ],
        )

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_cancelled_cloud(self, bump, _log):
        extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'cloud',
            'outcome': 'cancelled',
            'segments': 2,
            'segments_ok': 1,
            'cached': 0,
        })
        kinds = [c.args[0] for c in bump.call_args_list]
        self.assertEqual(
            kinds,
            [
                'info_highlight_run',
                'info_highlight_run__cloud',
                'info_highlight_run__cancelled',
            ],
        )

    def test_reject_bad_engine(self):
        body, status = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'gpu',
            'outcome': 'ok',
            'segments': 1,
        })
        self.assertEqual(status, 400)
        self.assertFalse(body['success'])

    def test_reject_zero_segments(self):
        body, status = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'ok',
            'segments': 0,
        })
        self.assertEqual(status, 400)
        self.assertFalse(body['success'])

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_duration_ms_in_log(self, bump, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'ok',
            'segments': 3,
            'segments_ok': 3,
            'cached': 0,
            'version': '0.1.3',
            'duration_ms': 1234,
        })
        self.assertEqual(out, {'success': True})
        kinds = [c.args[0] for c in bump.call_args_list]
        self.assertEqual(kinds, ['info_highlight_run', 'info_highlight_run__local'])
        details = log.call_args.args[1]
        self.assertIn('dur=1234', details)
        self.assertIn('v=0.1.3', details)

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_missing_duration_ms_ok(self, _bump, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'cloud',
            'outcome': 'failed',
            'segments': 1,
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertNotIn('dur=', details)

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_invalid_duration_ms_ok(self, _bump, log):
        for bad in ('nope', -12, True, None, ''):
            with self.subTest(duration_ms=bad):
                out = extension_usage_report({
                    'extension': 'info-highlight',
                    'engine': 'local',
                    'outcome': 'ok',
                    'segments': 1,
                    'duration_ms': bad,
                })
                self.assertEqual(out, {'success': True})
                details = log.call_args.args[1]
                self.assertNotIn('dur=', details)

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_duration_ms_clamped(self, _bump, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'ok',
            'segments': 1,
            'duration_ms': 99_000_000,
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertIn('dur=86400000', details)

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_error_text_not_in_usage_log(self, _bump, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'failed',
            'segments': 1,
            'duration_ms': 10,
            'error': 'should never appear in usage log',
            'message': 'also no',
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertIn('dur=10', details)
        self.assertNotIn('should never appear', details)
        self.assertNotIn('also no', details)


if __name__ == '__main__':
    unittest.main()
