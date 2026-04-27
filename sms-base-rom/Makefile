PRJNAME := bitsy_sms
OBJS    := bitsy_sms.rel

all: $(PRJNAME).sms

%.rel : %.c
	sdcc -c -mz80 --peep-file peep-rules.txt $<

$(PRJNAME).sms: $(OBJS)
	sdcc -o $(PRJNAME).ihx -mz80 --no-std-crt0 --data-loc 0xC000 \
	    crt0_sms.rel $(OBJS) SMSlib.lib PSGlib.lib
	ihx2sms $(PRJNAME).ihx $(PRJNAME).sms

clean:
	rm -f *.sms *.ihx bitsy_sms.rel *.asm *.sym *.noi *.map *.lst *.lk
