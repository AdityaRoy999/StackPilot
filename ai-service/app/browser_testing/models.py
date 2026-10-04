"""Reject a known incompatible planner deployment; do not infer arbitrary capabilities."""


def lacks_native_browser_tools(provider: str, model: str) -> bool:
    lowered = model.lower()
    return provider == 'nvidia_nim' and 'llama-3.2-' in lowered and 'vision' in lowered


def select_browser_planner(provider: str, model: str, runtime: dict, candidates: list[str]) -> tuple[str, str]:
    # A customized endpoint can explicitly declare a tested tool parser.
    if runtime.get('browser_tool_calling_enabled') is True or not lacks_native_browser_tools(provider, model):
        return model, ''
    for candidate in candidates:
        if candidate and candidate != model and not lacks_native_browser_tools(provider, candidate):
            return candidate, (f"Browser planner switched from {model} to {candidate}: the selected NIM vision deployment "
                               "does not support native function calling. Screenshots are sent only if the replacement supports images.")
    raise ValueError('The selected browser model lacks native function calling. Configure NVIDIA_NIM_BROWSER_PLANNER_MODEL with a tested tool-capable model.')
