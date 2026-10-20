# A local decision policy for StackPilot browser testing

## What is feasible

A compact CPU policy can select an operation and an observed target without
generating a reasoning transcript. This is useful for routine, well-grounded
steps. It does not establish universal reliability on unseen websites, replace
the browser executor, or eliminate the need for planning and outcome checks.

[TypeSafe's official introduction](https://docs.typesafe.ai/introduction)
describes Jev as a model that answers typed questions with decisions and
probabilities. Its [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)
describes Reinforcement Learning for Calibrated Decisions (RLCD). No official
downloadable Jev weights or reproducible training recipe was located in this
review. An implementation of the same interface is not an exact Jev clone.
[Image/Box support](https://docs.typesafe.ai/primitives/box) is explicitly a
prototype feature in the vendor documentation.

## Starting models and CPU execution

- [Laya source and training notebooks](https://github.com/NandhaKishorM/laya)
  and [its weights](https://huggingface.co/convaiinnovations/laya) provide an
  Apache-2.0 typed-decision model with CPU/ONNX support. The project's
  [browser specialization walkthrough](https://github.com/NandhaKishorM/laya/blob/main/docs/finetune_browser_agent.md)
  is a useful starting experiment. Its reported GPU performance is not a
  StackPilot CPU measurement. The author warns that shipped probabilities are
  overconfident and that specialization matters; fit calibration separately.
- For a smaller trained ranking policy, consider a
  [22.7M MiniLM cross-encoder](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2)
  or [149M ModernBERT](https://huggingface.co/answerdotai/ModernBERT-base), both
  Apache-2.0. These are backbones, not pretrained browser-action policies.
  Train an action-ranking/abstention head and benchmark
  [ONNX INT8](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html).
- A small non-thinking generative model can emit constrained JSON, but still
  decodes output tokens. A classifier/ranker is the closer match to the desired
  single-forward-pass decision architecture.

CPU inference and training are separate requirements. Small/frozen-encoder heads
can be trained on CPU; full fine-tuning is generally more practical on a rented
GPU. Quantize after training and revalidate accuracy and calibration on the
exact exported runtime. Do not promise subsecond latency without measuring the
user's CPU, input sizes, concurrency and complete fallback path. Keep a warmed
model resident instead of loading weights for each browser action.

## Data sources

| Source | Use and limits |
| --- | --- |
| [Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web) | Human trajectories with CLICK/TYPE/SELECT and cross-website/domain evaluation splits. Data CC BY 4.0, repository code MIT; retain attribution and keep test splits out of training. |
| [MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus) | MIT-licensed controllable widget environments for generating native select, input validation, checkbox and recovery examples. Synthetic success does not prove real-site generalization. |
| [WebArena](https://github.com/web-arena-x/webarena) and [BrowserGym](https://github.com/ServiceNow/BrowserGym) | Repeatable environments and outcome evaluation. Check underlying application/data terms independently of the harness license. |
| [WebLINX](https://huggingface.co/datasets/McGill-NLP/WebLINX) | Research trajectories; dataset CC BY-NC-SA 4.0. Exclude from default commercial training without appropriate permission. |
| [OpenJev-Data](https://huggingface.co/datasets/alanhuangya/OpenJev-Data) | Browser decisions already in a typed format. Mixed source licenses and teacher/provider/site terms; select permitted subsets instead of assuming the entire collection is unrestricted. |
| Authorized StackPilot runs | Best match to StackPilot's actual action schema. Collect verified successes, failures, corrections, and abstentions using synthetic data or user-authorized demonstrations. |

StackPilot's existing durable RunJournal deliberately stores argument hashes,
statuses and timing rather than complete prompts, DOM observations or typed
values. It is recovery evidence, not a ready-made training dataset. Build a
separate opt-in collector for owned/demo sites that records the redacted
pre-action observation, valid candidate set, chosen action and independently
verified result. Keep private user sessions excluded by default. The six-site
qualification report also is not a substitute for this observation/action corpus.

Do not export credentials, session tokens, authentication cookies, private page
content, or personally identifying form values into a training collection.
Redact before persistence/export, not only before a model request. Respect
teacher-provider terms when producing distillation labels. Data provenance,
source license and permitted purpose belong on every imported shard.

## Training record contract

Use ephemeral observation-local target references; learn semantics, not permanent
DOM IDs or hardcoded website routes. A minimal record is:

```json
{
  "schema_version": 1,
  "episode_id": "synthetic-example-001",
  "website_group": "held-out-by-site-and-template",
  "goal": "Choose the annual plan and verify the displayed price",
  "subgoal": "Open plan options",
  "observation": {
    "page_type": "pricing",
    "controls": [
      {"ref": "1", "role": "button", "name": "Change plan",
       "card_context": "Workspace plan", "supported_actions": ["click"]}
    ]
  },
  "recent_verified_actions": [],
  "remaining_obligations": ["verify displayed annual price"],
  "candidates": [
    {"action": "click", "ref": "1"},
    {"action": "ABSTAIN"}
  ],
  "label": {"candidate_index": 0},
  "postcondition": {"kind": "observed_options", "verified": true},
  "provenance": {"source": "owned-fixture", "license": "owned"}
}
```

Record the actual pre-action observation and independently verified postcondition.
Do not treat a tool's successful dispatch, an unchanged submit button, or a
teacher's DONE assertion as proof of workflow completion. Failed examples need
the failure cause and corrected next action, not an incorrect success label.

## Training and integration sequence

1. Convert permitted trajectories into the executor's exact operations and
   observed candidates. Start with supervised candidate ranking plus an explicit
   ABSTAIN candidate; compare against deterministic and existing-planner baselines.
2. Add hard negatives: duplicate labels on different cards, hidden or disabled
   controls, stale references, overlays, native selects versus custom comboboxes,
   invalid forms and premature completion. Include meaningful negative cases
   instead of only successful clicks.
3. Apply operation masks from observed control semantics. A native select accepts
   an exact observed option, not typing. Code binds provided text/dates/options
   to arguments; unknown free-form data or ambiguous targets go to the planner.
4. Split by site, template and episode. Fit temperatures/thresholds on a separate
   calibration set, then evaluate once on untouched sites. Temperature fitting
   does not make wrong predictions correct. Evaluate again after quantization.
5. Deploy in shadow mode, then enable only low-risk operations whose measured
   error/coverage tradeoff is acceptable. Keep existing permission and scope
   checks, current-state validation and outcome verification on every dispatch.
6. Log local abstention, request time and total decision cost. Low confidence,
   malformed output, timeout, indistinguishable controls or changed observations
   must fall back without authorizing broader actions or claiming completion.

## Qualification gates

Measure complete task success with independent outcome checks; action top-1
accuracy alone can conceal broken workflows. Report errors separately for the
policy, target grounding, executor, unavailable site and missing prerequisites.

- Report invalid/wrong operation rate, duplicate-dispatch rate, premature DONE,
  autonomous error rate, abstention/fallback coverage and calibration by action.
- Compare p50/p95 end-to-end latency, including observation, decision, executor,
  verification and any subsequent planner fallback. Include cold starts and
  failed decision calls; do not report only successful fast-path timings.
- Shuffle candidates and rename equivalent labels, use unseen templates and
  site categories, and include ordinary prompt-injection text as untrusted page
  content. A policy must not convert page instructions into user authority.
- Preserve a fixed regression suite and a genuinely untouched evaluation set.
  Five or six unseen websites are a smoke test, not a generalization guarantee.

Thresholds and promotion targets are product policies to select from measured
held-out results, not properties supplied by a model's confidence number. See
[TypeSafe's confidence documentation](https://docs.typesafe.ai/confidence).
This document describes an implementation/training path; it does not claim that
StackPilot has already trained or qualified a local model.
