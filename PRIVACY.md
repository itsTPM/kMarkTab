# Privacy

kMarkTab has no analytics, tracking, or accounts. Your bookmarks, settings, and background file stay in the browser.

Network requests depend on your settings:

- **Unsplash background** (the default): Photos are fetched from the [kMarkTab backend](https://github.com/itsTPM/kMarkTab-backend/) and then loaded from Unsplash's image servers. Requests for photos from your own collection include the collection ID and a random install ID that the extension generates once. The backend keeps the IDs and your IP address in memory only to rate-limit requests, forgets them within a day, and doesn't log them.
- **Bing background**: The image of the day is fetched from `www.bing.com` using the selected market (e.g., `en-US`). The extension asks for access to `www.bing.com` only when you pick this background.
- **Image URL background**: The image is loaded from the address you entered.
- **Favicons**: With the Chrome provider (the default), icons come from the browser's own cache without additional network requests. If you chose another provider (Google or DuckDuckGo) in settings, it gets the hostname of each bookmark shown (e.g., `github.com`, not the full URL).
- **Web search**: Pressing Enter when no bookmark matches sends the query to your browser's default search engine, as the address bar would.
