const STAR = "M10 1.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L10 15.1l-5.4 3 1.2-6.1L1.3 7.8l6.1-.7z";

export default function Stars({ rating, size = 16 }: { rating: number; size?: number }) {
  return (
    <span className="stars" aria-label={`${rating} out of 5 stars`}>
      {[0, 1, 2, 3, 4].map((index) => {
        const fill = Math.max(0, Math.min(1, rating - index));
        const id = `s${index}-${Math.round(rating * 10)}`;
        return (
          <svg key={index} width={size} height={size} viewBox="0 0 20 20">
            <defs>
              <linearGradient id={id}>
                <stop offset={fill} stopColor="#de7921" />
                <stop offset={fill} stopColor="#fff" />
              </linearGradient>
            </defs>
            <path d={STAR} fill={`url(#${id})`} stroke="#de7921" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        );
      })}
    </span>
  );
}
