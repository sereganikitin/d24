// pm2-конфиг. Секреты (GEMINI_API_KEY и т.д.) сюда не кладём — все
// переменные окружения (включая несекретные PORT/LLM_PROVIDER) читаются
// из server-side файла .env (в .gitignore, создаётся один раз на
// сервере из .env.example) через нативный --env-file у Node 20+.
module.exports = {
    apps: [
        {
            name: 'd24-voice-assist',
            cwd: __dirname,
            script: 'src/server.js',
            interpreter_args: '--env-file=.env',
        },
    ],
};
