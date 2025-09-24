// app.js - Complete fixed for static file serving, port override, and real-time logs

const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';
const PROJECTS_BASE_PATH = path.join(__dirname, 'deployments');
const LOGS_FILE_NAME = 'deployment-logs.txt';

const BASE_DOMAIN = 'https://testing-ax07.onrender.com';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));

// Main dashboard
app.get('/', (req, res) => {
    res.render('index', { projects });
});

app.get('/project/add', (req, res) => {
    res.render('add-project');
});

app.get('/project/:projectName', (req, res) => {
    const project = projects.find(p => p.name === req.params.projectName);
    if (!project) return res.status(404).send('Project not found.');

    const logFilePath = path.join(project.path, LOGS_FILE_NAME);
    fs.readFile(logFilePath, 'utf8', (err, data) => {
        if (!err) project.logs = data;
        res.render('project', { project });
    });
});

app.get('/project/:projectName/logs', (req, res) => {
    const project = projects.find(p => p.name === req.params.projectName);
    if (!project) return res.status(404).send('Project not found.');

    const logFilePath = path.join(project.path, LOGS_FILE_NAME);
    fs.readFile(logFilePath, 'utf8', (err, data) => {
        if (err) return res.status(500).send('Logs not found');
        res.send(data);
    });
});

app.post('/deploy', (req, res) => {
    const { projectName, repoUrl, buildCommand, startCommand } = req.body;
    if (projects.find(p => p.name === projectName)) {
        return res.status(400).send('Project with this name already exists.');
    }

    const newProject = {
        name: projectName,
        repoUrl,
        buildCommand,
        startCommand,
        status: 'Pending',
        logs: '',
        path: '',
        url: ''
    };
    projects.push(newProject);
    res.redirect('/');
    deployProject(newProject);
});

app.post('/delete-project', async (req, res) => {
    const { projectName } = req.body;
    const index = projects.findIndex(p => p.name === projectName);
    if (index === -1) return res.status(404).send('Project not found.');

    try {
        if (fs.existsSync(projects[index].path)) {
            fs.rmdirSync(projects[index].path, { recursive: true });
        }
        USED_PORTS.delete(projects[index].port);
        projects.splice(index, 1);
        res.redirect('/');
    } catch {
        res.status(500).send('Failed to delete project.');
    }
});

app.post('/webhook', (req, res) => {
    const repoUrl = req.body.repository.html_url;
    const projectToUpdate = projects.find(p => p.repoUrl === repoUrl);
    if (projectToUpdate) {
        updateProject(projectToUpdate);
        res.status(200).send('Webhook received and update triggered.');
    } else {
        res.status(404).send('Project not found.');
    }
});

// Fixed static file serving logic
app.use('/:projectName', (req, res, next) => {
    const projectName = req.params.projectName;
    
    // Skip main routes
    const mainRoutes = ['', 'deploy', 'webhook', 'project', 'delete-project'];
    if (mainRoutes.includes(projectName)) return next();

    const projPath = path.join(PROJECTS_BASE_PATH, projectName);
    
    // Check for common build directories first
    let servePath = projPath;
    if (fs.existsSync(path.join(projPath, 'build'))) {
        servePath = path.join(projPath, 'build');
    } else if (fs.existsSync(path.join(projPath, 'dist'))) {
        servePath = path.join(projPath, 'dist');
    }

    if (fs.existsSync(servePath)) {
        express.static(servePath)(req, res, err => {
            if (err) {
                res.status(404).send('File not found');
            }
        });
    } else {
        res.status(404).send('Project not found');
    }
});

io.on('connection', socket => {
    socket.on('joinProjectRoom', projectName => {
        socket.join(projectName);
    });
});

let projects = [];
const USED_PORTS = new Set();
const INITIAL_PORT = 1001; // Changed to start from 1001

function findAvailablePort() {
    let port = INITIAL_PORT;
    while (USED_PORTS.has(port) || port === PORT) {
        port++;
    }
    USED_PORTS.add(port);
    return port;
}

function appendLogToFile(projectPath, log) {
    if (!fs.existsSync(projectPath)) return;
    const logFilePath = path.join(projectPath, LOGS_FILE_NAME);
    fs.appendFile(logFilePath, log, (err) => {
        if (err) console.error('Failed to append logs:', err);
    });
}

function executeCommand(command, args, cwd, project) {
    return new Promise((resolve, reject) => {
        try {
            const cmd = spawn(command, args, { cwd, shell: true });

            cmd.stdout.on('data', data => {
                const msg = data.toString();
                project.logs += msg;
                io.to(project.name).emit('logUpdate', msg);
                appendLogToFile(project.path, msg);
                console.log(msg.trim());
            });

            cmd.stderr.on('data', data => {
                const text = data.toString();

                if (text.toLowerCase().includes('error') || text.toLowerCase().includes('fatal')) {
                    const msg = `ERROR: ${text}`;
                    project.logs += msg;
                    io.to(project.name).emit('logUpdate', msg);
                    appendLogToFile(project.path, msg);
                    console.error(msg.trim());
                } else {
                    project.logs += text;
                    io.to(project.name).emit('logUpdate', text);
                    appendLogToFile(project.path, text);
                    console.log(text.trim());
                }
            });

            cmd.on('close', code => {
                if (code !== 0) {
                    const errMsg = `Exited with status ${code}\n`;
                    project.logs += errMsg;
                    io.to(project.name).emit('logUpdate', errMsg);
                    appendLogToFile(project.path, errMsg);
                    return reject(new Error(errMsg));
                }
                resolve();
            });
        } catch (error) {
            const errMsg = `Command failed to start: ${error.message}\n`;
            project.logs += errMsg;
            io.to(project.name).emit('logUpdate', errMsg);
            appendLogToFile(project.path, errMsg);
            reject(new Error(errMsg));
        }
    });
}

async function deployProject(project) {
    const projectPath = path.join(PROJECTS_BASE_PATH, project.name);
    project.path = projectPath;

    try {
        if (!fs.existsSync(PROJECTS_BASE_PATH)) {
            fs.mkdirSync(PROJECTS_BASE_PATH, { recursive: true });
        }

        const emitLog = msg => {
            project.logs += msg + '\n';
            io.to(project.name).emit('logUpdate', msg + '\n');
            appendLogToFile(project.path, msg + '\n');
        };

        emitLog(`==> Cloning from ${project.repoUrl}`);
        project.status = 'Cloning';
        io.to(project.name).emit('statusUpdate', project.status);
        await executeCommand('git', ['clone', project.repoUrl, project.name], PROJECTS_BASE_PATH, project);

        emitLog(`==> Running build command: '${project.buildCommand}'`);
        project.status = 'Building';
        io.to(project.name).emit('statusUpdate', project.status);
        await executeCommand(project.buildCommand, [], projectPath, project);
        emitLog('==> Build successful 🎉');

        emitLog(`==> Running start command: '${project.startCommand}'`);
        project.status = 'Starting';
        io.to(project.name).emit('statusUpdate', project.status);
        const port = findAvailablePort();
        project.port = port;
        const env = {...process.env, PORT: port.toString()};
        const childProcess = spawn(project.startCommand, [], { 
            cwd: projectPath, 
            shell: true, 
            env 
        });

        childProcess.stdout.on('data', data => {
            const msg = data.toString();
            project.logs += msg;
            io.to(project.name).emit('logUpdate', msg);
            appendLogToFile(project.path, msg);
        });

        childProcess.stderr.on('data', data => {
            const msg = `ERROR: ${data.toString()}`;
            project.logs += msg;
            io.to(project.name).emit('logUpdate', msg);
            appendLogToFile(project.path, msg);
        });

        childProcess.on('close', code => {
            if (code !== 0) {
                const errMsg = `Start command exited with status ${code}\n`;
                project.logs += errMsg;
                io.to(project.name).emit('logUpdate', errMsg);
                appendLogToFile(project.path, errMsg);
                project.status = 'Error';
                io.to(project.name).emit('statusUpdate', project.status);
            }
        });

        setTimeout(() => {
            project.status = 'LIVE';
            io.to(project.name).emit('statusUpdate', project.status);
            const liveURL = `${BASE_DOMAIN}/${project.name}`;
            emitLog(`==> Your service is live 🎉`);
            emitLog(`==> Available at your primary URL ${liveURL}`);
            project.url = liveURL;
        }, 2000);

    } catch (error) {
        project.status = 'Error';
        io.to(project.name).emit('statusUpdate', project.status);
        const errMsg = `\nERROR: ${error.message}\n`;
        project.logs += errMsg;
        io.to(project.name).emit('logUpdate', errMsg);
        appendLogToFile(project.path, errMsg);
    }
}

async function updateProject(project) {
    const projectPath = path.join(PROJECTS_BASE_PATH, project.name);
    if (!fs.existsSync(projectPath)) {
        project.logs += 'Directory not found. Please deploy first.\n';
        io.to(project.name).emit('logUpdate', 'Directory not found. Please deploy first.\n');
        return;
    }

    project.status = 'Updating';
    io.to(project.name).emit('statusUpdate', project.status);
    const msg = 'Updating ' + project.name + ' from GitHub...\n';
    project.logs += msg;
    io.to(project.name).emit('logUpdate', msg);

    try {
        await executeCommand('git', ['pull'], projectPath, project);

        project.status = 'Building';
        io.to(project.name).emit('statusUpdate', project.status);
        const buildMsg = '\nRe-running build command: ' + project.buildCommand + '\n';
        project.logs += buildMsg;
        io.to(project.name).emit('logUpdate', buildMsg);
        await executeCommand(project.buildCommand, [], projectPath, project);

        project.status = 'Restarting';
        io.to(project.name).emit('statusUpdate', project.status);
        const startMsg = '\nRunning start command: ' + project.startCommand + '\n';
        project.logs += startMsg;
        io.to(project.name).emit('logUpdate', startMsg);

        const env = {...process.env, PORT: project.port.toString()};
        const childProcess = spawn(project.startCommand, [], { cwd: projectPath, shell: true, env });

        childProcess.stdout.on('data', (data) => {
            const logMessage = data.toString();
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
            appendLogToFile(project.path, logMessage);
        });

        childProcess.stderr.on('data', (data) => {
            const logMessage = `ERROR: ${data.toString()}`;
            project.logs += logMessage;
            io.to(project.name).emit('logUpdate', logMessage);
            appendLogToFile(project.path, logMessage);
        });

        childProcess.on('close', (code) => {
            if (code !== 0) {
                const errorMessage = `Start command exited with status ${code}\n`;
                project.logs += errorMessage;
                io.to(project.name).emit('logUpdate', errorMessage);
                appendLogToFile(project.path, errorMessage);
                project.status = 'Error';
                io.to(project.name).emit('statusUpdate', project.status);
            }
        });

        project.status = 'LIVE';
        io.to(project.name).emit('statusUpdate', project.status);
        project.logs += '\nProject ' + project.name + ' is now LIVE.\n';
        io.to(project.name).emit('logUpdate', '\nProject ' + project.name + ' is now LIVE.\n');
    } catch (error) {
        project.status = 'Error';
        io.to(project.name).emit('statusUpdate', project.status);
        const errorMsg = `\nERROR: ${error.message}\n`;
        project.logs += errorMsg;
        io.to(project.name).emit('logUpdate', errorMsg);
        appendLogToFile(project.path, errorMsg);
    }
}

server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
});