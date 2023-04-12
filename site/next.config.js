/** @type {import('next').NextConfig} */
const nextConfig = {
    experimental: {
        appDir: true,
    },

    redirects: [
        { source: '/blog', destination: 'https://blog.kualta.dev' },
        { source: 'vids.kualta.dev', destination: '/vids' },
    ],
};

module.exports = nextConfig;
