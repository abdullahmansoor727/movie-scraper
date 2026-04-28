![Example](example.gif)

# 🎬 Zenith Movies (Ad-Free Scraper)

A simple movie streaming frontend that pulls video sources using scripts originally based on Vidlink. This version removes ads and provides a clean, minimal playback experience.

## 🚀 Features

* 🎥 Stream movies directly in-browser
* ⚡ Fast loading using HLS streams
* 🚫 No ads (cleaned version of original scripts)
* 🌐 Deployed easily with Netlify
* 🔗 Simple URL-based playback system
* ⬇️ Copy an HLS URL or FFmpeg command for permitted downloads

## 🧠 How It Works

This project uses a scraping/proxy approach to retrieve video streams and display them in a native HTML5 player.

Example:

```
https://your-site.netlify.app/?id=550
```

* `id` = Movie ID (typically from TMDB or similar source)
* The app fetches and injects the stream into a video player
* Playback is handled using HLS

## 📁 Project Structure

```
/
├── index.html        # Main frontend/player
├── netlify.toml      # Netlify functions + redirect config
├── script.js         # WASM helper script loaded by the function
├── fu.wasm           # WASM helper loaded by the function
└── /api
    └── index.js      # Netlify function for stream lookup + proxying
```

## 🧑‍💻 Local Development

Install dependencies:

```bash
npm install
```

Run with the Netlify CLI:

```bash
npm install -g netlify-cli
npm start
```

Or without installing the CLI globally:

```bash
npx netlify-cli dev
```

Then open:

```text
http://localhost:8888/?id=550
```

## 🛠️ Deployment (Netlify)

1. Clone or fork this repo
2. Go to https://netlify.com
3. Click **"Add New Project"**
4. Import your repo
5. Deploy

Netlify reads `netlify.toml`, serves `index.html`, and routes `/api` to the serverless function at `api/index.js`.

Once deployed, your site will be live instantly.

## ⚠️ Important Notes

* This project is for **educational purposes only**
* Streaming copyrighted content without permission may violate laws in your country
* The original scripts were modified to remove ads, but credit belongs to their respective creators

## 📌 Usage

Just open:

```
https://your-netlify-site.netlify.app/?id=MOVIE_ID
```

For TV episodes:

```text
https://your-netlify-site.netlify.app/?id=TV_ID&s=1&e=1
```

When a stream is ready, use the `HLS URL` or `FFmpeg` button to copy the playlist URL or a ready-to-run command:

```bash
ffmpeg -i "HLS_URL" -c copy -bsf:a aac_adtstoasc "movie.mp4"
```

Only download streams when you have the right to do so.

## 💡 Future Improvements

* Custom video player UI
* Subtitles support
* TV / remote-friendly controls
* Better error handling

---

## ⭐ Support

If you like this project, consider giving it a star ⭐ on GitHub!
