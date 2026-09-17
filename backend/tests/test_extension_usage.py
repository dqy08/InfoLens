"""extension_usage_report 计数键。"""
import unittest
from unittest.mock import patch

from backend.api.extension_usage import extension_usage_report


def _bump_kinds(bump):
    return [c.args[0] for c in bump.call_args_list]


def _dur_kinds(kinds):
    return [k for k in kinds if '__dur_' in k]


def _kw_n(call):
    if 'n' in call.kwargs:
        return call.kwargs['n']
    if len(call.args) > 1:
        return call.args[1]
    return 1


class ExtensionUsageTest(unittest.TestCase):
    def _assert_no_duration_bumps(self, bump):
        self.assertEqual(_dur_kinds(_bump_kinds(bump)), [])

    def _assert_duration_bumps(self, bump, engine, duration_ms, bucket):
        kinds = _bump_kinds(bump)
        prefix = f'info_highlight_run__{engine}__'
        bucket_key = prefix + bucket
        sum_key = prefix + 'dur_sum_ms'
        n_key = prefix + 'dur_n'
        self.assertEqual(
            _dur_kinds(kinds),
            [bucket_key, sum_key, n_key],
        )
        by_key = {c.args[0]: c for c in bump.call_args_list}
        self.assertEqual(_kw_n(by_key[bucket_key]), 1)
        self.assertEqual(_kw_n(by_key[sum_key]), duration_ms)
        self.assertEqual(_kw_n(by_key[n_key]), 1)

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
        kinds = _bump_kinds(bump)
        self.assertEqual(
            kinds[:2],
            ['info_highlight_run', 'info_highlight_run__local'],
        )
        self._assert_duration_bumps(bump, 'local', 1234, 'dur_1_2s')
        details = log.call_args.args[1]
        self.assertIn('dur=1234', details)
        self.assertIn('v=0.1.3', details)

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_duration_ms_cloud_bucket_and_sum(self, bump, _log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'cloud',
            'outcome': 'ok',
            'segments': 2,
            'cached': 1,
            'duration_ms': 2500,
        })
        self.assertEqual(out, {'success': True})
        kinds = _bump_kinds(bump)
        self.assertEqual(
            kinds[:4],
            [
                'info_highlight_run',
                'info_highlight_run__cloud',
                'info_highlight_run__cached',
                'info_highlight_run__cloud__dur_2_5s',
            ],
        )
        self._assert_duration_bumps(bump, 'cloud', 2500, 'dur_2_5s')

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_duration_ms_bucket_boundaries(self, bump, _log):
        cases = (
            (0, 'dur_lt_500'),
            (499, 'dur_lt_500'),
            (500, 'dur_500_1s'),
            (999, 'dur_500_1s'),
            (1000, 'dur_1_2s'),
            (2000, 'dur_2_5s'),
            (4999, 'dur_2_5s'),
            (5000, 'dur_ge_5s'),
        )
        for duration_ms, bucket in cases:
            with self.subTest(duration_ms=duration_ms):
                bump.reset_mock()
                out = extension_usage_report({
                    'extension': 'info-highlight',
                    'engine': 'local',
                    'outcome': 'ok',
                    'segments': 1,
                    'duration_ms': duration_ms,
                })
                self.assertEqual(out, {'success': True})
                kinds = _bump_kinds(bump)
                self.assertEqual(
                    kinds[:2],
                    ['info_highlight_run', 'info_highlight_run__local'],
                )
                self._assert_duration_bumps(bump, 'local', duration_ms, bucket)

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_missing_duration_ms_ok(self, bump, log):
        out = extension_usage_report({
            'extension': 'info-highlight',
            'engine': 'cloud',
            'outcome': 'failed',
            'segments': 1,
        })
        self.assertEqual(out, {'success': True})
        details = log.call_args.args[1]
        self.assertNotIn('dur=', details)
        self.assertEqual(
            _bump_kinds(bump),
            [
                'info_highlight_run',
                'info_highlight_run__cloud',
                'info_highlight_run__failed',
            ],
        )
        self._assert_no_duration_bumps(bump)

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_invalid_duration_ms_ok(self, bump, log):
        for bad in ('nope', -12, True, None, ''):
            with self.subTest(duration_ms=bad):
                bump.reset_mock()
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
                self.assertEqual(
                    _bump_kinds(bump),
                    ['info_highlight_run', 'info_highlight_run__local'],
                )
                self._assert_no_duration_bumps(bump)

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_duration_ms_clamped(self, bump, log):
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
        self._assert_duration_bumps(bump, 'local', 86_400_000, 'dur_ge_5s')

    @patch('backend.api.extension_usage.log_request')
    @patch('backend.api.extension_usage.bump_api')
    def test_client_id_in_log(self, bump, log):
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
    @patch('backend.api.extension_usage.bump_api')
    def test_invalid_client_id_ignored(self, _bump, log):
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


class BumpApiNTest(unittest.TestCase):
    def test_rejects_non_positive_int(self):
        from collections import defaultdict
        from backend.platform import visit_stats

        old = visit_stats._API
        visit_stats._API = defaultdict(int)
        try:
            visit_stats.bump_api('k', n=-1)
            visit_stats.bump_api('k', n=True)
            visit_stats.bump_api('k', n=1.5)
            visit_stats.bump_api('k', n=0)
            self.assertEqual(visit_stats._API['k'], 0)
            visit_stats.bump_api('k', n=3)
            self.assertEqual(visit_stats._API['k'], 3)
        finally:
            visit_stats._API = old


if __name__ == '__main__':
    unittest.main()
