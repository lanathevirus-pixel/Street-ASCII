# Street ASCII — serveur (comptes + base permanente)

Un seul service Node : il sert le jeu, relaie le multijoueur (WebSocket `/ws`) et garde **comptes, sauvegardes, gangs et territoires** dans une base.

## Déployer sur Render
1. Dépôt GitHub : `index.html` (dans `public/`), `server.js`, `store.js`, `package.json`, `package-lock.json`, `og.png`, `favicon.png`.
2. Render → New Web Service : Build `npm install`, Start `node server.js`.
3. **Base permanente (obligatoire pour ne rien perdre)** — le disque gratuit de Render est effacé à chaque redéploiement. Deux options :
   - **Postgres gratuit (recommandé)** : crée une base sur neon.tech ou supabase.com, copie l'URL de connexion et ajoute-la dans Render → Environment : `DATABASE_URL=postgres://...`. La table est créée toute seule.
   - **Disque Render payant** : monte un disque sur `/data` (ou règle `DATA_DIR`) — les données sont écrites en JSON.
4. Vérifie sur `https://ton-site/info` : `"db":"postgres"` ou `"fichier"`.

Sans `DATABASE_URL` ni disque, le jeu fonctionne mais tout est perdu au redémarrage.

## Bouton « Soutenir la créatrice »

Sur Render → Environment, ajoute :

- `SUPPORT_URL` = ton lien (Ko-fi, Tipeee, PayPal… doit commencer par https://)
- `SUPPORT_LABEL` (facultatif) = texte du bouton (par défaut « Soutenir la créatrice »)

Change la valeur quand tu veux : Render redémarre le service et le bouton prend le nouveau lien, sans toucher au code. Si `SUPPORT_URL` est vide, le bouton reste caché.
