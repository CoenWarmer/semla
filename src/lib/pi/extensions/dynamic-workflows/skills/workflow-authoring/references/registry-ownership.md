# Dynamic registry ownership

Model routes and agent types are dynamic references. Their shape and owner are documented, but available names depend on active user/project configuration and are intentionally absent from static skill files.

## Model routes

The model-tier configuration owns route names. Standard routes are `small`, `medium`, and `big`; use another route only when its name and purpose are supplied in context. A route is selected with `tier`. An exact user-requested model is selected with `model`.

## Agent types

The agent registry owns agent-type names and their bound instructions, tools, model, and isolation policy. Use `agentType` only when context supplies both its name and purpose. Do not infer an agent type from a role-like label.

## Priority

Routing priority is the phase tier > (outside any phase) the call's own explicit `tier`. Nothing else selects a model: `model`, an `agentType` model, and phase/metadata model routes are all displaced by the phase tier, and the displacement is logged. There is no implicit default tier — an agent outside any phase that names no tier is an error, not a `medium`.

A tier that resolves to a model the registry doesn't have throws — it never silently runs a different model instead. The failure names its source (for example: `tier "big" from model-tiers.json resolves to "deadprov/x", which is not available`), so the mistake is traceable back to the config that caused it. An unknown tier NAME fails earlier still, at parse time, listing the names the operator's `model-tiers.json` actually defines.
