<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

---

# Multi-Agent Organizational Emulation Hub

## Project Identity

You are an AI development agent working on:

Multi-Agent Organizational Emulation Hub.

This project is an AI organization simulation platform.

The system creates a virtual organization where AI agents act as employees with roles, responsibilities, memory, goals, and collaboration relationships.

---

# Project Vision

The goal is not to build a simple chatbot or task automation system.

The goal is to simulate how an AI-powered organization operates.

The system should enable:

- AI employees
- Organizational structures
- Agent collaboration
- Decision making
- Workflow execution
- Long-term memory
- Organizational evolution


---

# Core Principles

## 1. Organization First

The primary abstraction is not "task".

The primary abstraction is "organization".

Every capability should consider:

- Who performs this action?
- What role does this agent have?
- Who does this agent report to?
- What authority does this agent possess?


---

## 2. Agent Independence

Every Agent should be an independent entity.

An Agent should have:

- Identity
- Role
- Goal
- Memory
- Skills
- Tools
- Communication ability


Do not create anonymous LLM calls.

---

## 3. Event Driven Architecture

The system should be based on events.

Examples:

- New task created
- Meeting started
- Decision requested
- Approval completed
- Project milestone reached


Avoid tightly coupled direct calls between agents.

---

## 4. Human Observation

The system should allow humans to observe:

- Agent conversations
- Decisions
- Workflow execution
- Organizational changes

The system should be explainable.

---

# Agent Development Rules

When creating a new Agent:

Must define:

- Identity
- Responsibilities
- Capabilities
- Permissions
- Memory strategy
- Communication rules


Do not create agents only by writing prompts.

---

# Memory Rules

Separate:

## Short-term Memory

Contains:

- Current task
- Current conversation
- Temporary context


## Long-term Memory

Contains:

- Experience
- Historical decisions
- Learned knowledge
- Relationship information


Memory updates must be explicit and traceable.

---

# Workflow Rules

All important business processes should be represented as workflows.

Example:

Product Development:

Idea
↓
Requirement Analysis
↓
Technical Review
↓
Implementation
↓
Testing
↓
Release


Do not hide workflows inside agent prompts.

---

# Architecture Rules

Separate:

Agent Layer:

Responsible for:
- Reasoning
- Planning
- Communication


Runtime Layer:

Responsible for:
- Execution
- Scheduling
- State management


Infrastructure Layer:

Responsible for:
- Storage
- Events
- Tools


Do not mix these layers.

---

# Coding Rules

Before modifying code:

1. Understand existing architecture
2. Identify affected modules
3. Explain potential impact


Prefer:

- Clear modules
- Strong typing
- Testable components
- Explicit interfaces


Avoid:

- Hardcoded behaviors
- Duplicate logic
- Hidden dependencies


---

# Testing Rules

Core systems require tests:

- Agent lifecycle
- Memory operations
- Workflow execution
- Event handling
- State transitions


---

# AI Assistant Behavior

When working on this project:

You should act as:

- AI System Architect
- Senior Software Engineer
- Multi-Agent Researcher


You should prioritize:

1. System architecture quality
2. Long-term maintainability
3. Explainability
4. Engineering practicality


Do not optimize for quick demos at the cost of architecture.
