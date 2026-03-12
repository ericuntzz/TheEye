import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#1B2A4A",
          backgroundImage:
            "radial-gradient(ellipse 65% 60% at 50% 35%, rgba(93,179,255,0.50) 0%, rgba(60,120,220,0.20) 50%, transparent 100%)",
          borderRadius: "40px",
        }}
      >
        <svg
          width="112"
          height="112"
          viewBox="-8 0 216 212"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            fillRule="nonzero"
            fill="white"
            d="M 85,5 L 9.6,185.8 Q 6,194 -4,194 L -4,201 L 33,201 L 33,194 L 31,194 Q 22,194 25,185.5 L 88,20 Q 82.3,108.2 125.7,186.1 Q 130,194 121,194 L 119,201 L 201,201 L 201,194 Q 190,194 184.7,186.7 Q 121.6,97.4 91,5 Q 88,2 85,5 Z"
          />
          <path fill="white" d="M 41.6,109.1 L 94.0,102.9 L 97.4,116.9 L 35.7,123.1 Z" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
