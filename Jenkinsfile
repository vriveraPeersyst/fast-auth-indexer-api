def PROJECT_NAME = scm.getUserRemoteConfigs()[0].getUrl().tokenize('/').last().split("\\.")[0]
def envFileName = UUID.randomUUID().toString()
def envFileDestination = "/tmp/${envFileName}"

pipeline {
    agent any
    environment {
        HOME = '.'
        DOCKERHUB_REPOSITORY = 'peersyst/global'
        DOCKERHUB_CREDENTIALS = credentials('peersyst-dockerhub')
        DOCKERHUB_TAG_NAME = "${DOCKERHUB_REPOSITORY}:${PROJECT_NAME}-${GIT_BRANCH}-${GIT_COMMIT}"
    }
    stages {
        stage('Install') {
            agent {
                docker {
                    image 'node:18'
                    reuseNode true
                }
            }
            steps {
                sh 'corepack enable && corepack prepare pnpm@8.15.4 --activate'
                sh 'pnpm install --frozen-lockfile'
            }
        }
        stage('Build') {
            agent {
                docker {
                    image 'node:18'
                    reuseNode true
                }
            }
            steps {
                sh 'corepack enable && corepack prepare pnpm@8.15.4 --activate'
                sh 'pnpm run build'
            }
        }
        stage('Lint') {
            agent {
                docker {
                    image 'node:18'
                    reuseNode true
                }
            }
            steps {
                sh 'corepack enable && corepack prepare pnpm@8.15.4 --activate'
                sh 'pnpm run lint'
            }
        }
        stage('Test') {
            agent {
                docker {
                    image 'node:18'
                    reuseNode true
                }
            }
            steps {
                sh 'corepack enable && corepack prepare pnpm@8.15.4 --activate'
                sh 'pnpm run test:coverage'
            }
        }
        stage('Build and push docker image') {
            when {
                anyOf { branch 'dev'; branch 'master'; branch 'main'; }
            }
            steps {
                sh "docker build . -t ${DOCKERHUB_TAG_NAME}"
                sh "echo $DOCKERHUB_CREDENTIALS_PSW | docker login -u $DOCKERHUB_CREDENTIALS_USR --password-stdin"
                sh "docker push ${DOCKERHUB_TAG_NAME}"
            }
        }
        stage('Deploy test environment') {
            when {
                branch 'dev'
            }
            steps {
                sshagent(credentials : ['jenkins-ssh']) {
                    configFileProvider(
                        [configFile(fileId: "${PROJECT_NAME}-env", variable: 'ENV_FILE')]) {
                        sh "scp -o StrictHostKeyChecking=no ${ENV_FILE} ubuntu@dev.peersyst.com:${envFileDestination}"
                    }
                    sh "ssh -o StrictHostKeyChecking=no ubuntu@dev.peersyst.com sudo docker kill ${PROJECT_NAME} || true"
                    sh "ssh -o StrictHostKeyChecking=no ubuntu@dev.peersyst.com sudo docker rm ${PROJECT_NAME} || true"
                    sh "ssh -o StrictHostKeyChecking=no ubuntu@dev.peersyst.com sudo docker pull ${DOCKERHUB_TAG_NAME}"
                    sh "ssh -o StrictHostKeyChecking=no ubuntu@dev.peersyst.com sudo docker run --name=${PROJECT_NAME} --env-file=${envFileDestination} --network=host -d ${DOCKERHUB_TAG_NAME}"
                    sh "ssh -o StrictHostKeyChecking=no ubuntu@dev.peersyst.com sudo rm ${envFileDestination}"
                }
            }
        }
    }
    post {
        always {
            sh 'docker logout'
        }
    }
}
