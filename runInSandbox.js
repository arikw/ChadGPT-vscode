const Docker = require('dockerode');
const fs = require('fs');
const tar = require('tar-fs');
let vscode;
try {
	vscode = require('vscode');
} catch (e) {
	console.log("Could not load vscode");
}


const docker = new Docker({
    socketPath: '/var/run/docker.sock',
});
const imageName = 'chadgpt-sandbox';


async function buildImage() {
    const dockerfileContents = fs.readFileSync('./Dockerfile', 'utf-8');
    const newDockerfileContents = `${dockerfileContents}\nRUN touch /tmp/chadgpt-history \nRUN apt-get update && apt-get install -y iptables screen\nRUN update-alternatives --set iptables /usr/sbin/iptables-legacy\nRUN update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy`;

    fs.writeFileSync('./Dockerfile-sandbox', newDockerfileContents, 'utf-8');

    const tarStream = tar.pack(process.cwd(), {
        entries: ['Dockerfile-sandbox'],
    });

    const stream = await docker.buildImage(tarStream, {
        t: imageName + ':latest',
        dockerfile: 'Dockerfile-sandbox',
    });

    await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, res) => {
            if (err) {
                console.log(err);
                reject(err);
            } else {
                resolve(res);
            }
        }, (event) => {
            console.log(event.stream ? event.stream.trim() : event);
        });
    });
}


async function getOrCreateImage() {
    const images = await docker.listImages();
    const imageExists = images.some(image => {
        return image.RepoTags.includes(imageName);
    });

    if (!imageExists) {
        await buildImage();
    }

    const imageInfo = await docker.getImage(imageName).inspect();
    return imageInfo;
}


async function createOrGetSandbox() {
    // check if a container with the given name exists
    const existingContainers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({ name: ['chadgpt-sandbox'] }),
    });
    if (existingContainers.length > 0) {
        // check if the container is running
        if (existingContainers[0].State === 'running') {
            return docker.getContainer(existingContainers[0].Id);
        }
        // if the container is not running, remove it
        const container = docker.getContainer(existingContainers[0].Id);
        await container.remove();
    }

    // get the image
    const imageInfo = await getOrCreateImage();

    // define options for the container

    const containerOptions = {
        Image: imageInfo.RepoTags[0],
        Tty: true,
        Cmd: ['/bin/bash', '-c', 'iptables -A OUTPUT -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -m multiport --dports 80,443 ! --syn -m comment --comment "Block POST and PUT requests" -j DROP && screen -S sandbox -dm && sleep infinity'],
        HostConfig: {
            Binds: [`${__dirname}:${__dirname}`],
            WorkingDir: `${__dirname}`,
            Privileged: true,
            AutoRemove: true,
        },
        name: 'chadgpt-sandbox',
    };
    // create and start the container
    const container = await docker.createContainer(containerOptions);
    await container.start();
    // wait 1 second
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return container;
}

/**
 * run a command in the sandbox and return the captured output.
 * Commands are run in a tmux session called sandbox.
 * 
 * Example:
 * let out1 = await runInSandbox('cd /tmp')
 * let out2 = await runInSandbox('pwd')
 * out2 === '/tmp'
 */
async function runInSandbox(cmd) {
    let container = await createOrGetSandbox();
    const endToken = Math.random().toString(36).substring(7);
    // escape the cmd to prevent it from being interpreted by the shell.
    cmd = cmd.replace('$', '\\$');

    const cmdWritingToHistory = `${cmd} > /tmp/chadgpt-history 2>&1 && echo ${endToken} >> /tmp/chadgpt-history || echo ${endToken} >> /tmp/chadgpt-history`;
    const exec = await container.exec({
        Cmd: ['screen', '-S', 'sandbox', '-X', 'stuff', `${cmdWritingToHistory}`+'\n'],
        AttachStderr: true,
    });
    await exec.start({ hijack: true, stdin: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return waitForEndToken(container, endToken);
}


async function waitForEndToken(container, endToken) {
    const history = await container.exec({
        Cmd: ['cat', '/tmp/chadgpt-history'],
        AttachStdout: true,
        AttachStderr: true,
    });
    const historyStream = await history.start({ hijack: true, stdin: true });
    const historyOutput = await new Promise((resolve) => {
        historyStream.on('data', (data) => {
            resolve(data.toString());
        });
    });
    if (!historyOutput.includes(endToken)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return waitForEndToken(container, endToken);
    } else {
        return historyOutput.split(endToken)[0];
    }
}




async function restartSandbox() {
    await buildImage();
    // kill sandbox if running
    const existingContainers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({ name: ['chadgpt-sandbox'] }),
    });
    if (existingContainers.length > 0) {
        const container = docker.getContainer(existingContainers[0].Id);
        await container.stop();
        await container.remove();
    }
    // create new sandbox
    await createOrGetSandbox();
}


async function runCommandsInSandbox(commands) {
    console.log("running commands:", commands);
    // set the vscode home dir as cwd for the command
    // const homeDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const homeDir = `/Users/nielswarncke/Documents/ChadGPT-vscode`;
    await runInSandbox(`cd ${homeDir}`);

    let output = ""
    for (const command of commands) {
        if (typeof command == "string") {
            const tmp = await runInSandbox(command);
            output += `> ${command}\n${tmp}\n\n`;
        }
    }

    // const output = await runInSandbox(`echo done ${endToken}`);
    return output;
}

// restartSandbox();

async function testCommands() {
    for(let i = 0; i < 1; i++) {
        let output = await runCommandsInSandbox(['pwd', 'python music.py', 'export a=1', 'echo $a', 'pip install numpy']);
        console.log(output, i);

    }
}
testCommands();


// module.exports = {
//     runCommandsInSandbox,
//     restartSandbox,
// };