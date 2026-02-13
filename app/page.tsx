import VideoUploader from "./components/VideoUploader";
import ScreenRecorder from "./components/ScreenRecorder";
import VideoList from "./components/VideoList";

export default function Home() {
  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <div className="logo">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="url(#gradient)" strokeWidth="2">
              <defs>
                <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#ff6b6b" />
                  <stop offset="100%" stopColor="#845ef7" />
                </linearGradient>
              </defs>
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
            <h1>Mux Video Uploader</h1>
          </div>
          <p className="tagline">Upload videos and record your screen directly to Mux</p>
        </div>
      </header>

      <main className="main-content">
        <div className="cards-grid">
          <div className="card">
            <VideoUploader />
          </div>
          <div className="card">
            <ScreenRecorder />
          </div>
        </div>
        
        <VideoList />
      </main>

      <footer className="app-footer">
        <p>
          Powered by{" "}
          <a href="https://mux.com" target="_blank" rel="noopener noreferrer">
            Mux
          </a>
          {" "}• Built with{" "}
          <a href="https://nextjs.org" target="_blank" rel="noopener noreferrer">
            Next.js
          </a>
        </p>
      </footer>
    </div>
  );
}
