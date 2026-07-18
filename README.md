<div align="center">
  <h1>SupportPilot</h1>
  <p><strong>Your AI-powered Slack Assistant for high-velocity engineering teams.</strong></p>
</div>

SupportPilot bridges the gap between your engineering ecosystem (GitHub, Jira, etc.) and your team's communication hub (Slack). By leveraging state-of-the-art LLMs, developers can request PR summaries, transition ticket statuses, and query project states entirely via natural language without leaving Slack.

---

## 🚀 Features

- **Conversational AI in Slack:** Talk to SupportPilot naturally in threads or channels to query your engineering stack.
- **Multi-Tenant Architecture:** Secure OAuth flow supporting multiple isolated Slack workspaces.
- **Multi-LLM Support:** Built-in adapters for OpenAI, Gemini, Groq, and OpenRouter, allowing you to choose the best LLM for your budget and latency needs.
- **High Performance:** NestJS backend backed by Redis caching and PostgreSQL for robust state and token management.
- **Extensible Tooling Pattern:** Easily plug in new integrations (e.g., Jira, GitHub, Notion, PagerDuty).

## 🛠 Tech Stack

- **Backend Framework:** NestJS (TypeScript)
- **Database:** PostgreSQL (managed via Prisma ORM)
- **Caching & Background Jobs:** Redis
- **Infrastructure:** AWS ECS Fargate, ALB, CloudFront, Terraform
- **CI/CD:** GitHub Actions

---

## 📦 Local Development

### Prerequisites
- Node.js (v18+)
- PostgreSQL
- Redis
- ngrok (for local Slack event routing)

### 1. Clone the repository
```bash
git clone https://github.com/shiven16/supportPilot.git
cd supportPilot
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root directory and populate it with the required keys:

```env
# Database & Cache
DATABASE_URL="postgresql://user:password@localhost:5432/supportpilot?schema=public"
REDIS_URL="redis://localhost:6379"

# Slack Credentials
SLACK_CLIENT_ID="your_slack_client_id"
SLACK_CLIENT_SECRET="your_slack_client_secret"
SLACK_SIGNING_SECRET="your_slack_signing_secret"
SELFSERVER_URL="https://your-ngrok-url.ngrok-free.app"

# LLM Providers (Add whichever you intend to use)
OPENAI_API_KEY="sk-..."
GEMINI_API_KEY="..."
GROQ_API_KEY="..."
```

### 4. Database Setup
Apply migrations and generate the Prisma client:
```bash
npx prisma generate
npx prisma migrate dev
```

### 5. Start the Server
```bash
# Start in watch mode for development
npm run start:dev
```

---

## 🔌 How to Integrate Another Tool

SupportPilot is designed with a highly extensible architecture, making it easy to add new integrations (like PagerDuty, Notion, or Linear) that the LLM can trigger as "tools".

Follow these steps to add a new tool integration:

### 1. Create the Integration Module
Create a new folder in your `src/` directory for the tool (e.g., `src/pagerduty`). Scaffold a module and service using the NestJS CLI:

```bash
nest g module pagerduty
nest g service pagerduty
```

### 2. Define the API Interactions
Inside your new `pagerduty.service.ts`, implement the logic required to interact with the third-party API. Ensure you handle authentication securely (preferably by storing tenant-specific access tokens in the database, similar to the `slack_workspaces` table).

```typescript
import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class PagerDutyService {
  async getOnCallPerson(workspaceId: string) {
    // 1. Fetch credentials for the workspace from DB
    // 2. Make API call to PagerDuty
    // 3. Return structured data to the LLM
  }
}
```

### 3. Register the Tool with the LLM Router
Locate the service responsible for routing LLM prompts (often the core bot/LLM service). You need to expose your new integration to the LLM by defining a **Tool Schema** (JSON Schema).

When initializing your LLM client (e.g., OpenAI or Gemini), pass the schema:

```typescript
const tools = [
  {
    type: "function",
    function: {
      name: "get_on_call_person",
      description: "Retrieves the currently on-call engineer from PagerDuty",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string", description: "The name of the engineering team" }
        },
        required: ["team"],
      }
    }
  }
];
```

### 4. Handle the LLM Function Call
When the LLM decides to invoke your tool, it will return a `tool_call` payload. Intercept this in your LLM orchestration service and route it to the service you created in Step 2.

```typescript
if (toolCall.function.name === 'get_on_call_person') {
    const args = JSON.parse(toolCall.function.arguments);
    const result = await this.pagerDutyService.getOnCallPerson(args.team);
    
    // Return the result back to the LLM to formulate the final Slack message!
}
```

By following this pattern, you can continually teach the AI new capabilities without modifying the core Slack event orchestration.

---

## ☁️ Deployment

The infrastructure is provisioned via **Terraform** inside the `/terraform` folder, designed to run on AWS ECS Fargate with a CloudFront HTTPS proxy. 

Every push to the `main` branch automatically triggers the `.github/workflows/deploy.yml` pipeline, which:
1. Builds a new Docker image.
2. Pushes it to AWS ECR.
3. Deploys the new revision to ECS Fargate.

> **Note:** The `SELFSERVER_URL` in production must point to the CloudFront distribution URL to properly handle Slack OAuth redirects.
