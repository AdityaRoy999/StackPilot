from copy import deepcopy


def tool(name, description, properties=None, required=None):
    return {'type': 'function', 'function': {'name': name, 'description': description,
            'parameters': {'type': 'object', 'properties': properties or {}, 'required': required or [], 'additionalProperties': False}}}


STRING = {'type': 'string'}
STRINGS = {'type': 'array', 'items': STRING}
COMPLETION_CHECK = {'type': 'object', 'properties': {
    'argv': STRINGS, 'root': STRING, 'image': STRING,
    'setup': {'type': 'array', 'items': STRINGS}, 'network': {'type': 'boolean'},
    'timeout_seconds': {'type': 'integer', 'minimum': 1, 'maximum': 300}, 'output_contains': STRINGS},
    'required': ['argv'], 'additionalProperties': False}
COMPLETION_CONTRACT = {'type': 'object', 'properties': {
    'version': {'type': 'integer', 'enum': [1]}, 'summary': STRING, 'workload': STRING, 'assumptions': STRINGS,
    'features': {'type': 'array', 'minItems': 1, 'maxItems': 32, 'items': {'type': 'object', 'properties': {
        'id': STRING, 'description': STRING, 'checks': {'type': 'array', 'minItems': 1, 'maxItems': 16, 'items': COMPLETION_CHECK}},
        'required': ['id', 'description', 'checks'], 'additionalProperties': False}}},
    'required': ['summary', 'workload', 'features'], 'additionalProperties': False}
TEAM_TOOLS = [
    tool('get_execution_capabilities', 'Inspect registered Linux sandbox capabilities and admitted toolchain images before choosing a worker. Docker can select versioned SDK images and provision isolated task instances, including Ubuntu. Admission is not successful execution. Missing capabilities return concrete prerequisites; cloud VM provisioning is not implemented.',
         {'capabilities': STRINGS, 'image': STRING}),
    tool('build_worker_image', 'Worker only: build a custom Linux SDK from a Dockerfile in this task source when a versioned SDK is insufficient. The isolated build receives source only, never platform credentials, host mounts or the Docker socket. Returns an observed immutable image digest scoped to this run; use it with run_worker_command or completion checks. A successful image build does not verify the application.',
         {'dockerfile': STRING, 'network': {'type': 'boolean'}, 'capabilities': STRINGS,
          'timeout_seconds': {'type': 'integer', 'minimum': 1, 'maximum': 900}}),
    tool('provision_worker_instance', 'Worker only: provision a persistent isolated Linux Docker instance for this task and execution attempt. Defaults to Ubuntu 24.04; image, network and resources must be admitted by server policy. Reuse the returned sandbox_id with run_worker_command for SDK setup and incremental compilation. Source changes still require scoped import and lead integration. The instance is reclaimed after task termination or TTL expiry and cannot be shared with another task. This is a container, not a VM, and does not prove application correctness.',
         {'image': STRING, 'network': {'type': 'boolean'}, 'capabilities': STRINGS,
          'memory_mb': {'type': 'integer', 'minimum': 64, 'maximum': 4096},
          'cpus': {'type': 'number', 'minimum': 0.1, 'maximum': 8},
          'pids_limit': {'type': 'integer', 'minimum': 16, 'maximum': 1024},
          'ttl_seconds': {'type': 'integer', 'minimum': 60, 'maximum': 86400}}),
    tool('inspect_worker_instance', 'Worker only: inspect this task attempt\'s Docker instance, its actual state, image and expiry. An instance owned by another task or an earlier attempt is denied.',
         {'sandbox_id': STRING}, ['sandbox_id']),
    tool('release_worker_instance', 'Worker only: release this task attempt\'s Docker instance after importing needed source changes through run_worker_command. This removes the instance and its temporary contents; scoped source already imported into the task remains available.',
         {'sandbox_id': STRING}, ['sandbox_id']),
    tool('define_completion_plan', 'Lead only: freeze the intended finished application and executable checks for every feature before release. Derive features from the user objective, README and original tests, including unfinished behavior. Record assumptions explicitly; do not invent missing product requirements silently. Checks execute independently on integrated source. Prefer inline assertion programs or original protected tests. Select real toolchain images/setup per check. The contract cannot be weakened after creation; a repository stackpilot.completion.json is authoritative.',
         {'contract': COMPLETION_CONTRACT}, ['contract']),
    tool('get_completion_status', 'Read the frozen completion contract and per-feature execution results for the current source revision. Further edits invalidate prior proof. This reports declared scope only, not universal product correctness.'),
    tool('analyze_repository', 'Read-only evidence about manifests, components, entrypoint candidates and delivery type. Does not execute source or prove correctness. Use before choosing a web/CLI/job/package adapter; preserve original application behavior.'),
    tool('submit_agent_patch', 'Worker only: submit the actual scoped source changes and finish this task. Call as soon as assigned work and targeted checks are done. The lead integrates peer patches and runs combined tests; do not wait for peers. Completion is not release verification.',
         {'summary':STRING},['summary']),
    tool('discover_agent_tools', 'Load additional tool schemas when needed. Choose browser, research, team, repository, or instances, or explicit tool names. Tools are available by capability, not a fixed specialist role.',
         {'group':STRING,'names':STRINGS}),
    tool('spawn_agent', 'Create a real asynchronous teammate with a goal and isolated source workspace. Choose its role freely. Assign disjoint write scopes for parallel edits; omit write_scope for read-only investigation. Returns queued, never verified completion.',
         {'goal': STRING, 'role': STRING, 'write_scope': STRINGS, 'depends_on': STRINGS, 'completion_contract': STRING}, ['goal']),
    tool('list_agents', 'Inspect this run\'s actual tasks, states, results, patches and unresolved prerequisites.'),
    tool('send_agent_message', 'Send a persistent message to a teammate ID or lead. Include interface requirements and evidence; never credentials.',
         {'recipient': STRING, 'message': STRING}, ['recipient', 'message']),
    tool('read_agent_messages', 'Read this agent\'s persistent inbox.', {'after': {'type': 'number'}}),
    tool('wait_agents', 'Wait for selected agents to finish, submit a patch, fail or become blocked. Individual actions continue streaming while waiting.',
         {'agent_ids': STRINGS, 'timeout_seconds': {'type': 'integer', 'minimum': 0, 'maximum': 60}}),
    tool('integrate_agent_patch', 'Lead only: apply a submitted patch with stale-source/conflict checks. Integration is not verification. Run combined tests and the verified deployment pipeline afterwards.',
         {'patch_id': STRING}, ['patch_id']),
    tool('read_agent_patch', 'Inspect a peer patch and its proposed file contents without changing any workspace.',
         {'patch_id': STRING}, ['patch_id']),
    tool('verify_agent_source', 'Lead only: queue independent execution of the accepted repository test commands on the current integrated source. Uses executor exit codes, not a teammate claim or image-supplied JSON. Select an allowed toolchain image and optional dependency setup argv commands. A successful verification is invalidated by further source edits.',
         {'image':STRING,'network':{'type':'boolean'},'setup':{'type':'array','items':STRINGS},'timeout_seconds':{'type':'integer','minimum':1,'maximum':300}}),
    tool('revise_agent_task', 'Lead only: replace a failed, blocked or submitted task with a new task based on the current integration source. Preserves patch history, rewires waiting dependencies and revokes the old task. Use this to resolve conflicts and retest; never force overwrite.',
         {'agent_id': STRING, 'goal': STRING, 'write_scope': STRINGS}, ['agent_id', 'goal']),
    tool('cancel_agent', 'Cancel a task and its descendants, revoking execution leases.', {'agent_id': STRING}, ['agent_id']),
    tool('request_prerequisite', 'Record an irreducible missing credential reference, capability or requirement and pause this task. Do not use for ordinary repairable source defects.',
         {'kind': STRING, 'description': STRING}, ['kind', 'description']),
    tool('resolve_agent_requirement', 'Lead only: resolve a requirement using evidence or a credential reference, then resume its blocked task. Never include secret values.',
         {'requirement_id': STRING, 'resolution': STRING}, ['requirement_id', 'resolution']),
    tool('run_worker_command', 'Run an argv command in an isolated Docker worker containing only this task\'s source, with no control-plane credentials or Docker socket. Omit sandbox_id for a fresh disposable worker, or supply this task attempt\'s provisioned sandbox_id to reuse installed SDKs and build state. An existing instance retains its admitted image/network policy. Source changes remain scoped and require integration. Independent release acceptance always uses fresh disposable workers.',
         {'argv': STRINGS, 'image': STRING, 'sandbox_id': STRING, 'timeout_seconds': {'type': 'integer', 'minimum': 1, 'maximum': 300},
          'network': {'type': 'boolean'}, 'capabilities': STRINGS}, ['argv']),
    tool('workspace_delete_file', 'Delete a scoped file only at its observed revision. Deleting tests cannot waive release acceptance.',
         {'file_path': STRING, 'expected_revision': STRING}, ['file_path', 'expected_revision']),
]
TEAM_NAMES = ({item['function']['name'] for item in TEAM_TOOLS} - {'analyze_repository', 'workspace_delete_file'}) | {'invoke_subagent'}
REPO_NAMES = {'analyze_repository', 'workspace_list_files', 'workspace_read_file', 'workspace_write_file', 'workspace_edit_file', 'workspace_delete_file', 'terminal_run_command'}
# Keep legacy names dispatchable so stale calls receive a blocked result, but
# never advertise capabilities the isolated repository runtime cannot execute.
SCOPED_UNAVAILABLE_TOOLS = {'terminal_run_command'}
INSTANCE_NAMES = {'provision_worker_instance', 'inspect_worker_instance', 'release_worker_instance'}
LEAD_UNAVAILABLE_TOOLS = SCOPED_UNAVAILABLE_TOOLS | INSTANCE_NAMES | {'run_worker_command','build_worker_image','submit_agent_patch','invoke_subagent'}
CHILD_TOOLS = (REPO_NAMES - SCOPED_UNAVAILABLE_TOOLS) | (TEAM_NAMES - {'define_completion_plan','integrate_agent_patch','verify_agent_source','resolve_agent_requirement','revise_agent_task'}) | {'web_search', 'web_fetch', 'browser_open_live_session', 'browser_observe',
    'browser_interact', 'browser_interact_batch', 'browser_assert', 'browser_close_session', 'browser_inspect_console',
    'browser_get_page_state','browser_audit_site'}


def child_schemas(registry):
    return [bound_schema(item) for item in registry if item['function']['name'] in CHILD_TOOLS]


def bound_schema(item):
    """Execution owns repository targets; the model supplies action inputs."""
    schema=deepcopy(item)
    parameters=schema['function']['parameters']
    bound={'project_id','deployment_id','user_id','session_id'}
    parameters['properties']={key:value for key,value in parameters.get('properties',{}).items() if key not in bound}
    parameters['required']=[key for key in parameters.get('required',[]) if key not in bound]
    if schema['function']['name']=='workspace_trigger_rebuild':
        schema['function']['description']='Build and deploy the current accepted source. Creates the first deployment when necessary. Unintegrated tasks or missing independent acceptance block release. Returns the exact deployment_id and job_id to verify with wait_for_deployment.'
    return schema


def lead_schemas(registry,names):
    return [bound_schema(item) for item in registry
            if item['function']['name'] in set(names)-LEAD_UNAVAILABLE_TOOLS]


TOOL_GROUPS = {
    'browser':{name for name in CHILD_TOOLS if name.startswith('browser_')},
    'research':{'web_search','web_fetch'},
    'team':TEAM_NAMES & CHILD_TOOLS,
    'repository':REPO_NAMES & CHILD_TOOLS,
    'instances':INSTANCE_NAMES,
}
INITIAL_TOOLS = {'analyze_repository','discover_agent_tools','workspace_list_files','workspace_read_file','workspace_write_file',
                 'workspace_edit_file','run_worker_command','build_worker_image','request_prerequisite','spawn_agent',
                 'send_agent_message','read_agent_messages','list_agents','wait_agents','submit_agent_patch','get_completion_status','get_execution_capabilities'}
INITIAL_TOOLS |= INSTANCE_NAMES
LEAD_INITIAL_TOOLS = (INITIAL_TOOLS - {'submit_agent_patch','run_worker_command'} - INSTANCE_NAMES) | {
    'define_completion_plan',
    'integrate_agent_patch','read_agent_patch','verify_agent_source','revise_agent_task',
    'resolve_agent_requirement','cancel_agent','workspace_trigger_rebuild','wait_for_deployment',
    'get_deployment_status','get_deployment_logs'}


def active_schemas(registry, names=None):
    active=set(names or INITIAL_TOOLS)
    return [item for item in child_schemas(registry) if item['function']['name'] in active]
