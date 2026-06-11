"""
compute_tool_append_suffix 集成测试（需 instruct 模型权重）。

运行: python -m unittest backend.tests.test_compute_tool_append_suffix
"""
from __future__ import annotations

import unittest

from backend.core.completion_generator import (
    _ASSISTANT_PLACEHOLDER,
    _IM_END,
    compute_tool_append_suffix,
)
from backend.models.model_manager import ModelSlot


def _model_available() -> bool:
    try:
        compute_tool_append_suffix("{}", slot=ModelSlot.INSTRUCT)
        return True
    except Exception:
        return False


@unittest.skipUnless(_model_available(), "instruct model weights not available")
class TestComputeToolAppendSuffix(unittest.TestCase):
    TOOL_NAME = "get_current_temperature"
    TOOL_CONTENT = '{"temperature": 22, "unit": "celsius"}'

    def test_suffix_excludes_placeholder_and_im_end_prefix(self):
        suffix = compute_tool_append_suffix(
            self.TOOL_CONTENT,
            tool_name=self.TOOL_NAME,
            slot=ModelSlot.INSTRUCT,
        )
        self.assertNotIn(_ASSISTANT_PLACEHOLDER, suffix)
        self.assertFalse(suffix.startswith(_IM_END))

    def test_suffix_varies_with_tool_content(self):
        a = compute_tool_append_suffix(
            self.TOOL_CONTENT,
            tool_name=self.TOOL_NAME,
            slot=ModelSlot.INSTRUCT,
        )
        b = compute_tool_append_suffix(
            '{"temperature": 99}',
            tool_name=self.TOOL_NAME,
            slot=ModelSlot.INSTRUCT,
        )
        self.assertNotEqual(a, b)

    def test_suffix_stable_for_same_inputs(self):
        kwargs = dict(
            tool_content=self.TOOL_CONTENT,
            tool_name=self.TOOL_NAME,
            enable_thinking=False,
            slot=ModelSlot.INSTRUCT,
        )
        self.assertEqual(
            compute_tool_append_suffix(**kwargs),
            compute_tool_append_suffix(**kwargs),
        )

    def test_suffix_contains_tool_content(self):
        suffix = compute_tool_append_suffix(
            self.TOOL_CONTENT,
            tool_name=self.TOOL_NAME,
            slot=ModelSlot.INSTRUCT,
        )
        self.assertIn(self.TOOL_CONTENT, suffix)


if __name__ == "__main__":
    unittest.main()
