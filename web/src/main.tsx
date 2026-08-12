import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const container = document.getElementById("root");

// Loud failure beats a blank white page: if index.html ever loses #root, the console
// should say so rather than leaving you guessing why nothing rendered.
if (!container) throw new Error("VoiceBite: #root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
