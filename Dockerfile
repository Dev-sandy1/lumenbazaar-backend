FROM node:24-alpine AS app

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY eslint.config.js .prettierrc.json ./
COPY apps ./apps
COPY packages ./packages
COPY prisma ./prisma
COPY scripts ./scripts

# Install all dependencies (including dev) so typecheck and migration tooling are available during build.
RUN pnpm install --frozen-lockfile

RUN pnpm prisma:generate && pnpm typecheck

ENV NODE_ENV=production

# Default runtime is the API. Operators override the command for worker, MCP, migrations,
# and health gates as described in docs/deployment/testnet.md.
CMD ["pnpm", "start:api"]
