"""extension_usage_report 访问日志。不写入 visit_stats。"""
import unittest
from unittest.mock import patch

from backend.api.extension_usage import extension_usage_report


class ExtensionUsageTest(unittest.TestCase):
    def test_reject_bad_engine(self):
        body, status = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'gpu',
            'outcome': 'ok',
            'segments': 1,
        })
        self.assertEqual(status, 400)
        self.assertFalse(body['success'])

    @patch('backend.api.extension_usage.log_request')
    def test_zero_segments_failed(self, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'cloud',
            'outcome': 'failed',
            'segments': 0,
            'error': 'No article text',
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertIn('seg=0', details)
        self.assertNotIn('No article text', details)

    @patch('backend.api.extension_usage.log_request')
    def test_zero_segments_cancelled(self, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'cancelled',
            'segments': 0,
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertIn('seg=0', details)

    @patch('backend.api.extension_usage.log_request')
    def test_duration_ms_in_log(self, log):
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
        details = log.call_args.args[1]
        self.assertIn('dur=1234', details)
        self.assertIn('v=0.1.3', details)
        self.assertNotIn('m=', details)

    @patch('backend.api.extension_usage.log_request')
    def test_missing_duration_ms_ok(self, log):
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
    def test_invalid_duration_ms_ok(self, log):
        for bad in ('nope', -12, True, None, ''):
            with self.subTest(duration_ms=bad):
                log.reset_mock()
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
    def test_duration_ms_clamped(self, log):
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
    def test_client_id_in_log(self, log):
        cid = 'a1b2c3d4-e5f6-4789-8abc-def012345678'
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'ok',
            'segments': 1,
            'client_id': cid,
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertIn(f'cid={cid}', details)

    @patch('backend.api.extension_usage.log_request')
    def test_invalid_client_id_ignored(self, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'cloud',
            'outcome': 'ok',
            'segments': 1,
            'client_id': 'not-a-uuid',
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertNotIn('cid=', details)

    @patch('backend.api.extension_usage.log_request')
    def test_error_text_not_in_usage_log(self, log):
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
        self.assertNotIn('m=', details)

    @patch('backend.api.extension_usage.log_request')
    def test_model_qwen_in_log(self, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'cloud',
            'outcome': 'ok',
            'segments': 1,
            'model': 'qwen3-0.6b',
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertIn('m=qwen3-0.6b', details)

    @patch('backend.api.extension_usage.log_request')
    def test_trigger_in_log(self, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'ok',
            'segments': 1,
            'trigger': 'icon',
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertIn('trigger=icon', details)

    @patch('backend.api.extension_usage.log_request')
    def test_unknown_trigger_truncated(self, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'cloud',
            'outcome': 'ok',
            'segments': 1,
            'trigger': 'x' * 40,
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertIn('trigger=' + ('x' * 16), details)
        self.assertNotIn('x' * 17, details)

    @patch('backend.api.extension_usage.log_request')
    def test_missing_trigger_ok(self, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'local',
            'outcome': 'ok',
            'segments': 1,
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertNotIn('trigger=', details)


if __name__ == '__main__':
    unittest.main()
