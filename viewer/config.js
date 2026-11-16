/* ==================================================================
 *  Globule — configuration du site de visionnage
 * ==================================================================
 *  C'est LE fichier à modifier si l'adresse de votre serveur de
 *  signalisation change (par ex. si vous changez d'hébergeur).
 *
 *  1. Remplacez DEFAULT_SERVER_URL ci-dessous par l'adresse exacte
 *     fournie par votre hébergeur, par exemple :
 *     wss://globule-serveur.onrender.com
 *     (attention : wss:// et pas ws:// pour une adresse https)
 *
 *  2. Republiez le site (git commit + push) — c'est tout.
 *
 *  Autres méthodes, sans republier :
 *    - Réglages du site : engrenage en haut à droite -> URL du serveur
 *      (mémorisée dans le navigateur de la personne qui visionne)
 *    - Lien direct : ajoutez &server=wss://... à l'adresse envoyée.
 * ================================================================== */

window.GLOBULE_CONFIG = {

  /* Adresse par défaut du serveur de signalisation.
     Mettez ici votre véritable adresse une fois le serveur déployé. */
  DEFAULT_SERVER_URL: 'wss://globule-serveur.onrender.com',

  /* Serveurs STUN utilisés pour établir la connexion directe.
     En cas d'échec de connexion, ajoutez un serveur TURN (voir GUIDE.md). */
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ],

  /* Texte affiché sous le bouton "Rejoindre" (personnalisable). */
  TAGLINE: 'Votre écran, chez elle, en direct.'
};
