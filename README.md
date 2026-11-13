![storage ui cover](public/readme/github-banner.png)

# Storage UI

<p align="start">
  <a href="https://storageui.dev">Website</a> ·
  <a href="https://demo.storageui.dev">Demo</a> ·
  <a href="https://storageui.dev/docs">Documentation</a>
</p>

<p align="start">
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-d9d9d9"></a>
  <a href="./docs/zh-CN/README.md"><img alt="简体中文文件" src="https://img.shields.io/badge/简体中文-d9d9d9"></a>
</p>

Open-source file browser for S3, R2, and other storage backends. Browse, preview, search, and manage files in a modern, self-hosted web interface.

## Features

- Icon, list, column, and gallery views
- Search, filtering, sorting, and lazy folder loading
- PDF, DOCX, XLSX, image, text, and code previews
- Multiple storage connections with local persistence
- Per-bucket read-only mode for environment-configured connections
- Responsive layout and dark mode

## Quick Start

### Docker

A prebuilt image is published on Docker Hub. Pull it, then run with your environment variables:

```bash
docker pull hahahumble/storageui

docker run -d \
  --name storage-ui \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  hahahumble/storageui
```

Create a `.env` file with the `STORAGE_1_*` variables (see [`.env.example`](.env.example)) before running.

### Deploy with Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/hahahumble/storageui)

### Local development

With [mise](https://mise.jdx.dev/) installed:

```bash
mise trust
mise install
mise run setup
mise run dev
```

Mise pins Node.js and Bun for this project. Production uses Node.js (`npm start`), whose socket hooks enforce private-endpoint protection for UI-added connections; the Docker image uses Node.js as well. Setup installs the locked dependencies and creates `.env.local` if it does not already exist.

Open `http://localhost:3000`. You can add a storage connection from the UI, or preconfigure server-side buckets by filling the `STORAGE_1_*` variables in `.env.local`.

### Login sessions

Set both `AUTH_USERNAME` and `AUTH_PASSWORD` to require sign-in. Each login gets a unique signed token that expires on the server after seven days. Changing either credential or `AUTH_SECRET` invalidates all existing tokens. Upgrading from the old token format also requires users to sign in again.

Logout removes the cookie from the current browser. It does not revoke a copied token; that token remains valid until its expiry or a credential/secret change.

## License

[Apache-2.0](LICENSE.md)
