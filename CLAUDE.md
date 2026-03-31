# Travio

## Project
- AI-powered travel route planner (personal project)
- Firebase project: travio-planner-app (Auth + Firestore)
- GitHub: https://github.com/Ouscuits/travio
- Live: https://ouscuits.github.io/travio/

## Tech Stack
- Vanilla JS, no frameworks
- Firebase Auth (email/password) + Firestore
- Claude API via Cloudflare Worker proxy (sitoclaude-proxy)
- GitHub Pages deployment
- PWA (installable on mobile)

## Structure
- index.html — Main app (all views + CSS)
- setup.html — One-time admin account creation
- js/firebase-config.js — Firebase init + secondary auth
- js/i18n.js — Translations (ES/EN/CA/FR/ZH) + t() function
- js/firestore.js — All CRUD operations
- js/route-form.js — Travel form + Claude API integration
- js/auth.js — Login, logout, roles, admin panel (loads LAST)

## Roles
- admin: full access, manage users
- user: plan routes, save routes

## Style
- Colors: #10B981 (emerald), #1A1A1A (dark), #ECFDF5 (bg)
- Fonts: DM Sans (body), Space Mono (mono)
- Travel/map theme, NOT SML branding

## Script Load Order
Firebase SDK → firebase-config → i18n → firestore → route-form → auth (LAST)
