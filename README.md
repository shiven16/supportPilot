# SupportPilot

SupportPilot is a multi-tenant Slack AI agent for engineering work. Team members can mention the bot, send it a DM, or use the Slack App Home tab to query and act on connected GitHub and Jira Cloud workspaces.

The application is a NestJS service backed by PostgreSQL and Redis. It uses LangChain tool calling: the model can call real integration APIs, inspect returned results, and decide its next action.

## Current capabilities

- Slack App Home onboarding, integration connection management, access controls, and administrator management.
- Slack app mentions, DMs, Assistant threads, and threaded replies. The bot adds an eyes reaction before processing supported messages.
- GitHub tools for repositories, files, issues, pull requests, reviews, commits, branches, and code search.
- Jira Cloud tools for issue search, issue details, create/update, comments, transitions, assignment, users, and projects.
- Slack tools for channels, messages, threads, users, reactions, and channel membership.
- A common date/time tool for relative-date requests.
- OpenAI-compatible provider selection for OpenAI, Gemini, Groq, and OpenRouter.
- Per-thread conversation state in PostgreSQL, including plans and recent tool-call results.
- Cheap acknowledgement filtering, intent/domain classification, domain-scoped tool loading, and tool-level selection before full schemas are bound.

## Architecture

```text
Slack event or interaction
        |
        v
NestJS Slack handlers and App Home
        |
        v
Noise filter -> intent/domain classifier -> domain tool selector
        |
        v
LangChain planner and tool-calling agent
        |
        +--> GitHub / Jira Cloud / Slack APIs
        |
        +--> PostgreSQL conversation and workspace state
        +--> Redis cache
```

The LLM pipeline first classifies a message from its text alone. It then loads tools only for the selected domain, asks the model to select the smallest useful tool set from names and descriptions, and finally binds full schemas for execution. The execution agent receives real tool results and may make additional tool calls.

`ToolService` caches eligible per-workspace toolsets in memory for 60 seconds. Connection events invalidate the affected workspace cache.

## Technology

- Node.js 22, TypeScript, NestJS 11
- LangChain and LangGraph
- PostgreSQL with Sequelize and `sequelize-cli` migrations
- Redis through Nest cache-manager
- Slack Web API, Bolt types, and Block Kit builders
- npm workspaces and local agent packages
- Docker Compose for local infrastructure
- Terraform, Amazon ECR, ECS Fargate, ALB, CloudFront, and GitHub Actions for the included AWS deployment path

This project does **not** use Prisma. Database schema changes are JavaScript Sequelize migrations in `src/database/migrations/`.

## Repository layout

```text
src/
  database/        Sequelize models, database configuration, migrations
  integrations/    credential validation, connection persistence, MCP support
  lib/             shared constants, encryption, Slack utilities, retention
  llm/             provider selection, classification, planning, tool execution
  slack/           Slack events, interactions, App Home, Block Kit views

agent-packages/packages/
  common/          shared tool contracts and date/time tool
  github/          GitHub LangChain toolkit
  jira/            Jira Cloud LangChain toolkit
  slack/           Slack LangChain toolkit

terraform/         AWS infrastructure
```

Each toolkit is an npm workspace package. The root application links them locally as `supportPilot-*-agent` dependencies.

## Prerequisites

- Node.js 22
- npm 10 or newer
- PostgreSQL 13 or newer
- Redis 7 or newer
- A publicly reachable HTTPS URL for Slack callbacks in local development, such as an ngrok tunnel
- A Slack app created from [slack_app_manifest.yml](./slack_app_manifest.yml)

## Configuration

Copy the example file and fill in the values for your environment:

```bash
cp .env.example .env
```

At minimum, configure the following values.

| Variable                                                  | Purpose                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                    | HTTP listening port. Defaults to `3000`.                                                                          |
| `SELFSERVER_URL`                                          | Public base URL used by Slack installation and callbacks.                                                         |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`                  | Slack OAuth app credentials.                                                                                      |
| `SLACK_SIGNING_SECRET`                                    | Verifies requests to `POST /slack/events`.                                                                        |
| `SLACK_BOT_TOKEN`                                         | Bot token used to initialize the Slack service.                                                                   |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL connection settings.                                                                                   |
| `REDIS_HOST`, `REDIS_PORT`                                | Redis connection settings.                                                                                        |
| `ENCRYPTION_KEY`                                          | Encryption key for workspace credentials and saved prompts. Set a strong, stable value outside local development. |
| `AI_PROVIDER_PRIORITY`                                    | Comma-separated provider priority, for example `openai,gemini,groq,openrouter`.                                   |

Set at least one provider API key. Providers are selected in the exact order in `AI_PROVIDER_PRIORITY`; entries without a key are skipped.

| Provider   | Required key         | Optional model/base URL variables                                                       |
| ---------- | -------------------- | --------------------------------------------------------------------------------------- |
| OpenAI     | `OPENAI_API_KEY`     | `OPENAI_MODEL`, `OPENAI_BASE_URL`                                                       |
| Gemini     | `GEMINI_API_KEY`     | `GEMINI_MODEL`, `GEMINI_BASE_URL`                                                       |
| Groq       | `GROQ_API_KEY`       | `GROQ_MODEL`, `GROQ_BASE_URL`                                                           |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME` |

Gemini, Groq, and OpenRouter are configured through OpenAI-compatible chat-completion endpoints. Workspace-level OpenAI keys can also be added from the App Home tab.

## Local development

Install root dependencies, build the local agent packages, and apply database migrations before starting NestJS:

```bash
npm install
npm run build:packages
npm run db:migrate
npm run start:dev
```

`start:dev` watches NestJS source only. Re-run `npm run build:packages` after changing code under `agent-packages/`.

Useful commands:

```bash
npm run build:packages  # Compile common, GitHub, Jira, and Slack agent packages
npm run build           # Compile the NestJS application
npm test                # Run Jest tests
npm run db:migrate      # Apply Sequelize migrations
npm run db:migrate:undo # Revert the most recent migration
```

### Local Docker services

The included Compose file starts the app, PostgreSQL, and Redis:

```bash
docker compose -f docker-compose.local.yml up --build
```

For a fresh local database, start PostgreSQL and Redis first, apply migrations from the host, then start the app:

```bash
docker compose -f docker-compose.local.yml up -d postgres redis
DB_HOST=localhost npm run db:migrate
docker compose -f docker-compose.local.yml up --build app
```

The production Docker image intentionally omits development dependencies, including `sequelize-cli`; run migrations from the host or CI rather than inside that final image.

## Slack setup

1. In Slack, create an app from [slack_app_manifest.yml](./slack_app_manifest.yml).
2. Replace the manifest placeholders with your public URLs:
   - Redirect URL: `https://your-host/slack/install`
   - Event request URL: `https://your-host/slack/events`
   - Interactivity request URL: `https://your-host/slack/interactions`
3. Copy the Slack client ID, client secret, signing secret, and bot token into `.env`.
4. Start SupportPilot, then open `https://your-host/slack/install` to install it in a workspace.
5. Open the SupportPilot App Home tab to configure access, admins, LLM keys, and integrations.

The public health endpoints are `GET /health` and `GET /api/health`.

## Connecting integrations

Connections are saved per Slack workspace. Credential fields are encrypted before persistence.

### GitHub

Connect GitHub from App Home with a Personal Access Token. The connection form validates the token with GitHub's `/user` API. A token with `repo` and `read:user` permissions is required for the supported private-repository and user operations. You can optionally set a default repository, owner, and tool instruction.

### Jira Cloud

Connect Jira from App Home with:

- Jira Cloud URL, such as `https://your-team.atlassian.net`
- Atlassian account email
- Atlassian API token
- optional default project key and custom tool instruction

The connection is validated with Jira REST API v3. Jira uses Basic Auth with the configured email and API token; no Jira OAuth client credentials are required.

## Adding an integration

Agent capabilities live in isolated packages under `agent-packages/packages/`. A new toolkit should expose a `Toolkit` through `supportPilot-common-agent`, define Zod schemas, wrap functions with LangChain `tool()`, and return compact API results.

To make a new integration available in the application, add its package to the root npm workspaces and local dependencies, register its connected configuration and toolkit in `src/llm/tool.service.ts`, and add the workspace connection flow and persistence model/migration. The classifier derives its configured domains from `INTEGRATIONS`.

## Deployment

The repository includes Terraform and a deployment workflow for AWS. On pushes to `main`, [deploy.yml](./.github/workflows/deploy.yml) performs the following:

1. Applies the Terraform configuration.
2. Builds and pushes the Docker image to Amazon ECR.
3. Installs npm dependencies and applies Sequelize migrations.
4. Renders a new ECS task definition with configured secrets.
5. Deploys the revision to the SupportPilot ECS service.

Terraform provisions the VPC networking, ALB, ECR repository, ECS cluster and Fargate service, CloudWatch logs, and CloudFront distribution. The workflow requires AWS credentials, an existing Terraform state bucket, database and Redis credentials, Slack credentials, `SELFSERVER_URL`, and whichever LLM provider keys are enabled.
