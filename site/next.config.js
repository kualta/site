/** @type {import('next').NextConfig} */
const nextConfig = {
    experimental: {
        appDir: true,
    },
    rewrites: [
        {
            source: '/:path*',
            has: [
                {
                    type: 'host',
                    value: 'vids.kualta.dev',
                },
            ],
            destination: '/vids/:path*',
        },
        {
            source: '/blog*',
            destination: 'https://blog.kualta.dev'
        }
    ],
};

module.exports = nextConfig;
