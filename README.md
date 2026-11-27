# Street ASCII — jeu + multijoueur hors Claude

Un seul service Node : il sert le jeu (`public/index.html`) et relaie les joueurs par WebSocket (`/ws`).

## Déploiement sur Render (gratuit)
1. Mets ce dossier dans un dépôt GitHub (ou dans un sous-dossier, puis *Root Directory* = ce dossier).
2. Render → New → Web Service → ce dépôt. Runtime Node, Build `npm install`, Start `npm start`.
3. Ouvre l'adresse `https://….onrender.com` : le multijoueur marche pour tout le monde, sans compte.

Offre gratuite : le service s'endort après ~15 min sans visite (premier chargement lent).
