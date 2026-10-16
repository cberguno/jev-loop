/** @type {import('next').NextConfig} */
const nextConfig = {
  // "standalone" is only needed for the Docker image; Vercel uses the default.
  output: process.env.DOCKER_BUILD ? "standalone" : undefined,
  poweredByHeader: false,
};

export default nextConfig;