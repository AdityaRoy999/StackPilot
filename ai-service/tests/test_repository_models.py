import unittest
from app.agent_runtime.models import select_repository_planner


class RepositoryPlannerAdmission(unittest.TestCase):
    def test_incompatible_hosted_vision_has_configured_native_tool_planner(self):
        selected,notice=select_repository_planner('nvidia_nim','meta/llama-3.2-11b-vision-instruct',{},['','meta/llama-3.2-90b-vision-instruct','openai/gpt-oss-20b'])
        self.assertEqual(selected,'openai/gpt-oss-20b')
        self.assertIn('native function calling',notice)

    def test_no_compatible_configured_planner_returns_actionable_prerequisite(self):
        with self.assertRaisesRegex(ValueError,'NVIDIA_NIM_AGENT_PLANNER_MODEL'):
            select_repository_planner('nvidia_nim','meta/llama-3.2-11b-vision-instruct',{},[])

    def test_explicitly_verified_tool_parser_and_other_models_keep_selection(self):
        for provider,model,runtime in [('nvidia_nim','meta/llama-3.2-11b-vision-instruct',{'native_tool_calling_enabled':True}),('openai','gpt-5',{}),('nvidia_nim','openai/gpt-oss-20b',{})]:
            self.assertEqual(select_repository_planner(provider,model,runtime,['fallback']),(model,''))
