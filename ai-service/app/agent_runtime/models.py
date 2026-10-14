"""Admission for a known incompatible hosted native-tool deployment."""
def select_repository_planner(provider,model,runtime,candidates):
    incompatible=provider=='nvidia_nim' and 'llama-3.2-' in model.lower() and 'vision' in model.lower()
    if not incompatible or runtime.get('native_tool_calling_enabled') is True:return model,''
    for candidate in candidates:
        if candidate and candidate!=model and not ('llama-3.2-' in candidate.lower() and 'vision' in candidate.lower()):
            return candidate,('Repository planner switched from '+model+' to '+candidate+': the selected hosted vision deployment does not support native function calling.')
    raise ValueError('The selected hosted vision model cannot execute repository tools. Configure a tested NVIDIA_NIM_AGENT_PLANNER_MODEL.')
