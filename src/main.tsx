import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ShadowApp from "./ShadowApp";

const shadow = new URLSearchParams(window.location.search).get("shadow") === "1";
document.body.classList.toggle("shadow-body", shadow);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {shadow ? <ShadowApp /> : <App />}
  </React.StrictMode>,
);
