# Fast browser decisions

StackPilot can use a System One decision server to choose a next click from observed controls. A targeted task in Fast mode can skip the chat-model request when both the operation and target have sufficient probability. The existing executor still checks permissions, live targets, occlusion and the actual response. The decision server cannot declare task completion.

This adapter supports the typed-choice HTTP protocol used by [Jev](https://github.com/browser-use/jev-ultrafast) and [Laya](https://github.com/NandhaKishorM/laya). Laya can run on a separate Linux server using its PyTorch backend; Jev's hosted endpoint requires its API key. No model weights are bundled with StackPilot or loaded into the browser worker.

## Run Laya on your decision server

Follow the upstream installation instructions for your server's Python and PyTorch runtime. A basic Linux installation is:

```sh
git clone https://github.com/NandhaKishorM/laya.git
cd laya
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[serve]'
export LAYA_MODELS=multilingual
export LAYA_DEVICE=cpu
export LAYA_PRELOAD=1
# Set LAYA_API_KEY to your own secret when authenticating remote requests.
laya-serve
```

Use `LAYA_DEVICE=cuda` when the server has a compatible GPU runtime. Model loading and available memory belong to this separate service; profile your server before choosing its concurrency. Put the authenticated endpoint on your private network or HTTPS reverse proxy.

## Connect StackPilot

Set the full POST URL in StackPilot's environment, then recreate its AI service. An empty URL keeps the feature off.

```dotenv
STACKPILOT_BROWSER_DECISION_URL=https://decisions.example.com/v1/systemone
STACKPILOT_BROWSER_DECISION_MODEL=multilingual
STACKPILOT_BROWSER_DECISION_KEY=
```

Set the key to the same secret as `LAYA_API_KEY` when server authentication is enabled. For hosted Jev, use `https://api.typesafe.ai/v1/systemone`, a supported Jev model ID, and your Jev key.

```sh
# Development compose
docker compose --profile ai up -d --no-deps ai-service
# Production compose
docker compose -f docker-compose.prod.yml up -d --no-deps ai-service
```

Only the URL is required for an unauthenticated private Laya service. The model can be omitted to use the server's default. Existing AI provider configuration stays in place for planning, questions, text entry and final verification.

## Selection and fallback

The adapter considers at most 16 visible, enabled, non-editable click controls. Larger action spaces, broad audits, Thinking mode, recovery turns and follow-ups containing user answers use the planner. Instructions containing credential terms also stay with the planner.

The payload contains the task, page title, URL without its query or fragment, and control labels/roles. It excludes screenshots, page body, form values and chat history. Email addresses and long phone numbers are masked. Other task text and page labels still go to the configured service, so use an endpoint you trust.

Both choices must name observed options and provide finite probabilities that sum to approximately one, with the selected option being a maximum. The default minimum chosen probability is `0.95`; configure `STACKPILOT_BROWSER_DECISION_THRESHOLD` between `0.8` and `1`. This is a selection threshold, not a measured success rate. Laya and Jev use different confidence formulas, so StackPilot validates the chosen probability instead of treating their confidence fields as interchangeable.

A changed local observation, uncertain result or repeated unchanged choice returns control to the planner. HTTP failures, malformed answers or timeout disable the decision server for the rest of that request. The default timeout is two seconds; `STACKPILOT_BROWSER_DECISION_TIMEOUT_SECONDS` accepts `0.1` to `5` seconds.

## Measure before enabling broadly

Adapter tests cover malformed probabilities, unknown targets, changed controls, repeated choices, credential exclusion, timeout fallback and permission gating. Chromium fixtures cover the underlying executor and batch compiler. These are not a benchmark of a deployed Laya/Jev model.

Evaluate actual workflow success and decision latency on held-out sites before changing the threshold. Include login, popups, custom pickers, delayed content and form outcomes. Retain explicit assertions and compare end-to-end success and time against the planner alone. No decision model guarantees reliable navigation of every website.
