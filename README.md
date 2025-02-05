# Proxy Server

A Cloudflare Workers proxy server for handling media and HLS streaming, built with TypeScript and Hono.

## Features

- HLS (HTTP Live Streaming) proxy support
- Media file proxy with content type validation
- CORS and secure headers configuration
- Built on Cloudflare Workers platform
- TypeScript implementation
- Streaming response handling

## Tech Stack

- [Hono](https://hono.dev) - Fast web framework for edge runtimes
- TypeScript
- Cloudflare Workers
- Biome - Code formatter and linter
- Wrangler - Cloudflare Workers CLI tool

## Prerequisites

- Node.js >= 18
- pnpm package manager
- Cloudflare account

## Installation

```bash
# Install dependencies
pnpm install